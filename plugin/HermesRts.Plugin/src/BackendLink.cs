using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Outbound WebSocket link to the RTS backend. The game server never listens;
    /// it dials the backend, matching packages/schemas/src/plugin.ts.
    /// Protocol: hello -> telemetry/status; backend -> order; plugin -> ack.
    /// </summary>
    public sealed class BackendLink : IDisposable
    {
        public const int SchemaVersion = 1;

        private readonly PluginConfig _config;
        private readonly Func<IEnumerable<string>> _capabilities;
        private readonly Action<string, string> _log;
        private WssClient _socket;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly BlockingCollection<string> _outbox = new BlockingCollection<string>(1000);
        private readonly HashSet<string> _seenOrders = new HashSet<string>(StringComparer.Ordinal);
        private readonly Queue<string> _seenOrderOrder = new Queue<string>();
        private readonly object _dedupeLock = new object();

        private Task _runTask;
        private long _lastMessageTicks;
        private int _connected;

        /// <summary>Called for every valid backend -> plugin order frame.</summary>
        public Action<JObject> OnOrder;

        /// <summary>Calls for status/event frames the backend sends.</summary>
        public Action<JObject> OnServerMessage;

        /// <summary>
        /// When true the handler acks itself (from the game thread) instead of
        /// the socket thread acking on receipt.
        /// </summary>
        public bool DeferAcks;

        public BackendLink(PluginConfig config, Func<IEnumerable<string>> capabilities, Action<string, string> log)
        {
            _config = config;
            _capabilities = capabilities;
            _log = log;
        }

        public bool IsConnected
        {
            get { return Interlocked.CompareExchange(ref _connected, 0, 0) == 1; }
        }

        public TimeSpan SinceLastMessage
        {
            get
            {
                var ticks = Interlocked.Read(ref _lastMessageTicks);
                if (ticks == 0) return TimeSpan.MaxValue;
                return DateTime.UtcNow - new DateTime(ticks, DateTimeKind.Utc);
            }
        }

        public void Start()
        {
            if (_runTask != null) return;
            _runTask = Task.Run((Func<Task>)RunAsync);
        }

        public void SendTelemetry(JObject telemetry)
        {
            Enqueue(telemetry.ToString(Formatting.None));
        }

        public void SendStatus(JObject status)
        {
            Enqueue(status.ToString(Formatting.None));
        }

        private void Enqueue(string json)
        {
            if (string.IsNullOrEmpty(json)) return;
            if (!_outbox.TryAdd(json))
            {
                string dropped;
                _outbox.TryTake(out dropped);
                _outbox.TryAdd(json);
            }
        }

        private async Task RunAsync()
        {
            var backoffMs = 1000;
            _log("info", "backend target: " + _config.BackendUrl + " (serverId=" + _config.ServerId +
                ", agentId=" + _config.AgentId + ", token=" + (_config.Token.Length > 0 ? "set" : "EMPTY") + ")");
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    // A ClientWebSocket cannot be reused after Abort/Close; a
                    // fresh instance per reconnect attempt is required.
                    if (_socket != null) _socket.Dispose();
                    _socket = new WssClient();
                    await _socket.ConnectAsync(new Uri(_config.BackendUrl), _cts.Token).ConfigureAwait(false);
                    Interlocked.Exchange(ref _connected, 1);
                    Interlocked.Exchange(ref _lastMessageTicks, DateTime.UtcNow.Ticks);
                    _log("info", "backend connected: " + _config.BackendUrl);
                    backoffMs = 1000;

                    await SendHelloAsync().ConfigureAwait(false);
                    var sender = Task.Run((Func<Task>)SendLoopAsync);
                    await ReceiveLoopAsync().ConfigureAwait(false);
                    try { await sender.ConfigureAwait(false); } catch { /* link is going down */ }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    _log("warn", "backend link error: " + ex.GetType().Name + ": " + ex.Message +
                        (_socket != null && !string.IsNullOrEmpty(_socket.LastError) ? " | " + _socket.LastError : ""));
                }
                finally
                {
                    Interlocked.Exchange(ref _connected, 0);
                    try { if (_socket != null) _socket.Abort(); } catch { }
                }

                if (_cts.IsCancellationRequested) break;

                try { await Task.Delay(backoffMs, _cts.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
                backoffMs = Math.Min(backoffMs * 2, 30000);
            }
        }

        private async Task SendHelloAsync()
        {
            var hello = new JObject
            {
                ["schemaVersion"] = SchemaVersion,
                ["type"] = "hello",
                ["agentId"] = _config.AgentId,
                ["serverId"] = _config.ServerId,
                ["version"] = Plugin.Version,
            };
            var caps = new JArray();
            foreach (var c in _capabilities()) caps.Add(c);
            hello["capabilities"] = caps;
            if (!string.IsNullOrEmpty(_config.Token)) hello["token"] = _config.Token;

            await SendTextAsync(hello.ToString(Formatting.None)).ConfigureAwait(false);
        }

        private async Task SendLoopAsync()
        {
            foreach (var json in _outbox.GetConsumingEnumerable(_cts.Token))
            {
                await SendTextAsync(json).ConfigureAwait(false);
            }
        }

        private async Task SendTextAsync(string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token)
                .ConfigureAwait(false);
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[64 * 1024];
            var message = new StringBuilder();

            while (!_cts.IsCancellationRequested && _socket.State == WebSocketState.Open)
            {
                var result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _log("info", "backend closed the link");
                    return;
                }

                message.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                if (!result.EndOfMessage) continue;

                var text = message.ToString();
                message.Clear();
                Interlocked.Exchange(ref _lastMessageTicks, DateTime.UtcNow.Ticks);
                HandleFrame(text);
            }
        }

        private void HandleFrame(string text)
        {
            JObject frame;
            try { frame = JObject.Parse(text); }
            catch (Exception ex)
            {
                _log("warn", "malformed frame ignored: " + ex.Message);
                return;
            }

            var type = (string)frame["type"];
            if (type == "order")
            {
                var orderId = (string)frame["orderId"];
                if (string.IsNullOrEmpty(orderId))
                {
                    _log("warn", "order without orderId ignored");
                    return;
                }

                if (!RememberOrder(orderId))
                {
                    _log("info", "duplicate order ignored: " + orderId);
                    SendAck(orderId, true, null);
                    return;
                }

                var ok = true;
                string error = null;
                try
                {
                    if (OnOrder != null) OnOrder(frame);
                }
                catch (Exception ex)
                {
                    ok = false;
                    error = ex.GetType().Name + ": " + ex.Message;
                    _log("error", "order " + orderId + " failed: " + error);
                }
                if (DeferAcks) return;
                SendAck(orderId, ok, error);
                return;
            }

            try
            {
                if (OnServerMessage != null) OnServerMessage(frame);
            }
            catch (Exception ex)
            {
                _log("warn", "server message handler failed: " + ex.Message);
            }
        }

        private bool RememberOrder(string orderId)
        {
            lock (_dedupeLock)
            {
                if (_seenOrders.Contains(orderId)) return false;
                _seenOrders.Add(orderId);
                _seenOrderOrder.Enqueue(orderId);
                while (_seenOrderOrder.Count > _config.OrderDedupeCapacity)
                {
                    var old = _seenOrderOrder.Dequeue();
                    _seenOrders.Remove(old);
                }
                return true;
            }
        }

        private void SendAck(string orderId, bool ok, string error)
        {
            var ack = new JObject
            {
                ["schemaVersion"] = SchemaVersion,
                ["type"] = "ack",
                ["orderId"] = orderId,
                ["ok"] = ok,
                ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            if (!string.IsNullOrEmpty(error)) ack["error"] = error.Length > 500 ? error.Substring(0, 500) : error;
            SendStatus(ack);
        }

        /// <summary>Public ack for deferred (game-thread) execution.</summary>
        public void Ack(string orderId, bool ok, string error)
        {
            SendAck(orderId, ok, error);
        }

        /// <summary>Forward a fully-built event frame (game thread -> backend).</summary>
        public void SendEvent(JObject frame)
        {
            if (frame != null) SendStatus(frame);
        }

        public void Dispose()
        {
            try { _cts.Cancel(); } catch { }
            try
            {
                if (_socket != null && _socket.State == WebSocketState.Open)
                    _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "shutdown", CancellationToken.None).Wait(2000);
            }
            catch { }
            try { if (_socket != null) _socket.Dispose(); } catch { }
            try { _outbox.CompleteAdding(); } catch { }
            try { if (_runTask != null) _runTask.Wait(2000); } catch { }
        }
    }
}
