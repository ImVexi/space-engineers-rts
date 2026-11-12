using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Net.WebSockets;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Minimal RFC 6455 client (ws:// only). Why not ClientWebSocket: under
    /// wine-mono 6.13 + SE's net48 profile, System.Net.WebSockets.ClientWebSocket
    /// fails every connect with "WebSocketException: Unable to connect to the
    /// remote server" even though a raw TCP connect to the same host:port
    /// succeeds from inside the same container (verified on the test server).
    /// This class speaks the handshake and frames directly over TcpClient and is
    /// therefore independent of the mono HTTP stack. Text frames only, no
    /// extensions, no TLS.
    /// </summary>
    public sealed class WssClient : IDisposable
    {
        private TcpClient _tcp;
        private NetworkStream _stream;
        private readonly byte[] _rx = new byte[64 * 1024];
        public WebSocketState State { get; private set; } = WebSocketState.None;
        public string LastError { get; private set; }

        public async Task ConnectAsync(Uri uri, CancellationToken ct)
        {
            if (uri == null) throw new ArgumentNullException("uri");
            if (uri.Scheme != "ws") throw new NotSupportedException("only ws:// is supported (no TLS)");

            LastError = null;
            State = WebSocketState.Connecting;
            _tcp = new TcpClient();
            _tcp.NoDelay = true;
            try
            {
                // Connect by IP literal when possible: under wine-mono the
                // string overload goes through the mono/win32 resolver, which
                // reported "Connection refused" for a literal that a raw
                // /dev/tcp test reached. Parsing the literal removes DNS from
                // the path.
                IPAddress addr;
                if (IPAddress.TryParse(uri.Host, out addr))
                    await _tcp.ConnectAsync(addr, uri.Port).ConfigureAwait(false);
                else
                    await _tcp.ConnectAsync(uri.Host, uri.Port).ConfigureAwait(false);
                _stream = _tcp.GetStream();
                _stream.ReadTimeout = 30000;
                _stream.WriteTimeout = 30000;

                var keyBytes = new byte[16];
                using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(keyBytes);
                var key = Convert.ToBase64String(keyBytes);

                var path = string.IsNullOrEmpty(uri.PathAndQuery) ? "/" : uri.PathAndQuery;
                var hostHeader = uri.IsDefaultPort ? uri.Host : uri.Host + ":" + uri.Port;
                var request = "GET " + path + " HTTP/1.1\r\n" +
                              "Host: " + hostHeader + "\r\n" +
                              "Upgrade: websocket\r\n" +
                              "Connection: Upgrade\r\n" +
                              "Sec-WebSocket-Key: " + key + "\r\n" +
                              "Sec-WebSocket-Version: 13\r\n\r\n";
                var reqBytes = Encoding.ASCII.GetBytes(request);
                await _stream.WriteAsync(reqBytes, 0, reqBytes.Length, ct).ConfigureAwait(false);
                await _stream.FlushAsync(ct).ConfigureAwait(false);

                var header = await ReadHeadersAsync(ct).ConfigureAwait(false);
                var status = header.Split('\n')[0].Trim();
                if (!status.Contains("101"))
                {
                    LastError = "handshake rejected: " + status;
                    State = WebSocketState.Closed;
                    throw new IOException(LastError);
                }

                var expected = Convert.ToBase64String(SHA1.Create().ComputeHash(
                    Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                if (header.IndexOf(expected, StringComparison.Ordinal) < 0)
                {
                    LastError = "handshake: Sec-WebSocket-Accept mismatch";
                    State = WebSocketState.Closed;
                    throw new IOException(LastError);
                }

                State = WebSocketState.Open;
            }
            catch (Exception ex)
            {
                LastError = ex.GetType().Name + ": " + ex.Message;
                State = WebSocketState.Closed;
                throw;
            }
        }

        private async Task<string> ReadHeadersAsync(CancellationToken ct)
        {
            var sb = new StringBuilder();
            var one = new byte[1];
            while (sb.Length < 8192)
            {
                var n = await _stream.ReadAsync(one, 0, 1, ct).ConfigureAwait(false);
                if (n <= 0) throw new IOException("connection closed during handshake");
                sb.Append((char)one[0]);
                if (sb.Length >= 4 && sb[sb.Length - 4] == '\r' && sb[sb.Length - 3] == '\n' &&
                    sb[sb.Length - 2] == '\r' && sb[sb.Length - 1] == '\n')
                    return sb.ToString();
            }
            throw new IOException("handshake header too large");
        }

        public async Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType type, bool endOfMessage, CancellationToken ct)
        {
            if (State != WebSocketState.Open) throw new IOException("socket not open");
            var frame = BuildFrame(type, buffer.Array, buffer.Offset, buffer.Count, endOfMessage);
            await _stream.WriteAsync(frame, 0, frame.Length, ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
        }

        private static byte[] BuildFrame(WebSocketMessageType type, byte[] payload, int offset, int count, bool fin)
        {
            // Header: b0 (FIN|opcode), b1 (MASK|len7/126/127), optional 2- or
            // 8-byte length, then the 4-byte masking key. The MASK bit lives in
            // b1 - it is not a separate byte.
            var extLen = count > 65535 ? 8 : count > 125 ? 2 : 0;
            var headerLen = 2 + extLen + 4;
            var frame = new byte[headerLen + count];
            frame[0] = (byte)((fin ? 0x80 : 0x00) | (type == WebSocketMessageType.Text ? 0x1 : 0x2));

            var p = 1;
            if (extLen == 8)
            {
                frame[p++] = 0x80 | 127;
                var len = (ulong)count;
                for (var i = 7; i >= 0; i--) frame[p++] = (byte)((len >> (8 * i)) & 0xFF);
            }
            else if (extLen == 2)
            {
                frame[p++] = 0x80 | 126;
                frame[p++] = (byte)((count >> 8) & 0xFF);
                frame[p++] = (byte)(count & 0xFF);
            }
            else
            {
                frame[p++] = (byte)(0x80 | count);
            }

            var mask = new byte[4];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(mask);
            Buffer.BlockCopy(mask, 0, frame, p, 4);
            p += 4;
            for (var i = 0; i < count; i++) frame[p + i] = (byte)(payload[offset + i] ^ mask[i % 4]);
            return frame;
        }

        /// <summary>Reads one frame. Control frames are handled internally.</summary>
        public async Task<WsFrame> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken ct)
        {
            while (true)
            {
                var b0 = await ReadByteAsync(ct).ConfigureAwait(false);
                var b1 = await ReadByteAsync(ct).ConfigureAwait(false);
                if (b0 < 0 || b1 < 0) { State = WebSocketState.Closed; return new WsFrame { MessageType = WebSocketMessageType.Close }; }

                var fin = (b0 & 0x80) != 0;
                var opcode = b0 & 0x0F;
                var masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126)
                {
                    len = (await ReadByteAsync(ct) << 8) | await ReadByteAsync(ct);
                }
                else if (len == 127)
                {
                    len = 0;
                    for (var i = 0; i < 8; i++) len = (len << 8) | (byte)await ReadByteAsync(ct);
                }

                var mask = new byte[4];
                if (masked) await ReadExactAsync(mask, 0, 4, ct).ConfigureAwait(false);
                if (len > _rx.Length) throw new IOException("frame too large: " + len);
                await ReadExactAsync(_rx, 0, (int)len, ct).ConfigureAwait(false);
                if (masked) for (var i = 0; i < len; i++) _rx[i] ^= mask[i % 4];

                if (opcode == 0x8)
                {
                    // Echo close and finish.
                    try
                    {
                        var closing = BuildFrame(WebSocketMessageType.Close, new byte[0], 0, 0, true);
                        await _stream.WriteAsync(closing, 0, closing.Length, ct).ConfigureAwait(false);
                    }
                    catch { }
                    State = WebSocketState.Closed;
                    return new WsFrame { MessageType = WebSocketMessageType.Close };
                }
                if (opcode == 0x9) // ping
                {
                    var pong = BuildFrame(WebSocketMessageType.Binary, _rx, 0, (int)len, true);
                    pong[0] = (byte)(0x80 | 0xA);
                    await _stream.WriteAsync(pong, 0, pong.Length, ct).ConfigureAwait(false);
                    continue;
                }
                if (opcode == 0xA) continue; // pong

                var copy = Math.Min((int)len, buffer.Count);
                Buffer.BlockCopy(_rx, 0, buffer.Array, buffer.Offset, copy);
                return new WsFrame
                {
                    MessageType = opcode == 0x1 ? WebSocketMessageType.Text : WebSocketMessageType.Binary,
                    Count = copy,
                    EndOfMessage = fin && copy == len,
                };
            }
        }

        private async Task<int> ReadByteAsync(CancellationToken ct)
        {
            var one = new byte[1];
            var n = await _stream.ReadAsync(one, 0, 1, ct).ConfigureAwait(false);
            return n <= 0 ? -1 : one[0];
        }

        private async Task ReadExactAsync(byte[] buf, int offset, int count, CancellationToken ct)
        {
            var read = 0;
            while (read < count)
            {
                var n = await _stream.ReadAsync(buf, offset + read, count - read, ct).ConfigureAwait(false);
                if (n <= 0) throw new IOException("connection closed mid-frame");
                read += n;
            }
        }

        public Task CloseAsync(WebSocketCloseStatus status, string reason, CancellationToken ct)
        {
            State = WebSocketState.Closed;
            try { if (_tcp != null) _tcp.Close(); } catch { }
            return Task.CompletedTask;
        }

        public void Abort()
        {
            State = WebSocketState.Aborted;
            try { if (_tcp != null) _tcp.Close(); } catch { }
        }

        public void Dispose()
        {
            try { if (_stream != null) _stream.Dispose(); } catch { }
            try { if (_tcp != null) _tcp.Close(); } catch { }
            State = WebSocketState.Closed;
        }
    }

    public struct WsFrame
    {
        public WebSocketMessageType MessageType;
        public int Count;
        public bool EndOfMessage;
    }
}
