// HERMES UNIFORM FIRMWARE — one identical script on every grid.
// Identity and role come from Custom Data, never from per-ship code.
//
// Custom Data format (one per line):
//   HERMES_ID=<stable id>
//   HERMES_ROLE=<relay|scout|miner|hauler|fighter|...>
//   HERMES_GOAL=<hover|orbit|interplanetary|crash>
//
// IGC: listens on tag "HERMES"; accepts "CMD|MOVE|x|y|z|speed",
// "CMD|HOLD", "CMD|STOP", "CMD|DOCK|<name>", "CMD|UNDOCK", "CMD|STATUS".
// The leading CMD| is optional. Status is broadcast on "HERMES_STATUS".
//
// UNCOMPILED. PB sandbox rules apply: no network, no file system, no threads.
// Exact autopilot/connector/LCD members are marked VERIFY and must be checked
// on a test server before this is used anywhere live.

const string FIRMWARE_VERSION = "0.2.0-partB";
const string IGC_TAG = "HERMES";
const string STATUS_TAG = "HERMES_STATUS";

IMyRemoteControl _rc;
IMyTextPanel _lcd;
IMyBroadcastListener _listener;

string _id = "unset";
string _role = "unassigned";
string _goal = "hover";
string _state = "boot";
Vector3D _target = Vector3D.Zero;
bool _hasTarget = false;
double _statusAcc = 0;
double _broadcastAcc = 0;

public Program()
{
    Runtime.UpdateFrequency = UpdateFrequency.Update10;
    ParseIdentity();
    FindBlocks();
    _listener = IGC.RegisterBroadcastListener(IGC_TAG);
    _listener.SetMessageCallback(IGC_TAG); // VERIFY: callback tag form on this build
    WriteStatus("boot");
}

public void Main(string argument, UpdateType updateSource)
{
    FindBlocks();

    if (!string.IsNullOrEmpty(argument))
    {
        HandleCommand(argument);
    }

    if (_listener != null)
    {
        while (_listener.HasPendingMessage)
        {
            MyIGCMessage msg = _listener.AcceptMessage();
            if (msg.Data != null) HandleCommand(msg.Data.ToString());
        }
    }

    if ((updateSource & UpdateType.Update10) != 0)
    {
        _statusAcc += Runtime.TimeSinceLastRun.TotalSeconds;
        _broadcastAcc += Runtime.TimeSinceLastRun.TotalSeconds;

        if (_statusAcc >= 1.0)
        {
            _statusAcc = 0;
            WriteStatus(_state);
        }
        if (_broadcastAcc >= 2.0)
        {
            _broadcastAcc = 0;
            BroadcastStatus();
        }
    }
}

public void Save()
{
    Storage = _id + "|" + _role + "|" + _goal + "|" + _state;
}

void HandleCommand(string raw)
{
    if (string.IsNullOrEmpty(raw)) return;

    string[] parts = raw.Trim().Split('|');
    int i = 0;
    if (parts.Length > 0 &&
        (parts[0].Equals("HERMES", StringComparison.OrdinalIgnoreCase) ||
         parts[0].Equals("CMD", StringComparison.OrdinalIgnoreCase)))
    {
        i = 1;
    }
    if (i >= parts.Length) return;

    string verb = parts[i].Trim().ToUpperInvariant();

    if (verb == "STATUS")
    {
        WriteStatus("status");
        BroadcastStatus();
        return;
    }
    if (verb == "STOP")
    {
        Stop();
        return;
    }
    if (verb == "HOLD")
    {
        Hover();
        return;
    }
    if (verb == "DOCK")
    {
        string name = parts.Length > i + 1 ? parts[i + 1].Trim() : "";
        Dock(name);
        return;
    }
    if (verb == "UNDOCK")
    {
        string name = parts.Length > i + 1 ? parts[i + 1].Trim() : "";
        Undock(name);
        return;
    }
    if (verb == "MOVE" || verb == "GOTO" || verb == "WAYPOINT")
    {
        if (parts.Length < i + 4)
        {
            _state = "bad-move";
            WriteStatus(_state);
            return;
        }
        double x, y, z, speed;
        if (!double.TryParse(parts[i + 1], out x) ||
            !double.TryParse(parts[i + 2], out y) ||
            !double.TryParse(parts[i + 3], out z))
        {
            _state = "bad-move";
            WriteStatus(_state);
            return;
        }
        speed = 10;
        if (parts.Length > i + 4) double.TryParse(parts[i + 4], out speed);
        FlyTo(new Vector3D(x, y, z), speed);
        return;
    }

    _state = "unknown-cmd";
    WriteStatus(_state);
}

void FlyTo(Vector3D target, double speed)
{
    if (_rc == null)
    {
        _state = "no-remote-control";
        WriteStatus(_state);
        return;
    }

    // VERIFY: autopilot surface. FlightMode/SpeedLimit are the classic PB API;
    // newer builds may expose equivalent properties on rc.Autopilot.
    _rc.ClearWaypoints();
    _rc.AddWaypoint(new MyWaypointInfo("hermes", target));
    _rc.FlightMode = FlightMode.OneWay;
    _rc.SpeedLimit = (float)Math.Max(1.0, speed);
    _rc.SetAutoPilotEnabled(true);

    _target = target;
    _hasTarget = true;
    _state = "enroute";
    WriteStatus(_state);
}

void Hover()
{
    if (_rc == null)
    {
        _state = "no-remote-control";
        WriteStatus(_state);
        return;
    }

    // VERIFY: there is no universal "hover" mode across SE versions. This
    // holds a low-speed waypoint just above the current position; test it
    // under gravity on the test server before trusting it.
    Vector3D here = Me.GetPosition();
    _rc.ClearWaypoints();
    _rc.AddWaypoint(new MyWaypointInfo("hermes-hold", here + new Vector3D(0, 0.5, 0)));
    _rc.FlightMode = FlightMode.OneWay;
    _rc.SpeedLimit = 1.0f;
    _rc.DampenersOverride = true;
    _rc.SetAutoPilotEnabled(true);

    _target = here;
    _hasTarget = true;
    _state = "holding";
    WriteStatus(_state);
}

void Stop()
{
    if (_rc != null)
    {
        _rc.SetAutoPilotEnabled(false);
        _rc.ClearWaypoints();
    }
    _state = "stopped";
    WriteStatus(_state);
}

void Dock(string name)
{
    IMyShipConnector connector = FindConnector(name);
    if (connector == null)
    {
        _state = "no-connector";
        WriteStatus(_state);
        return;
    }
    connector.Connect(); // VERIFY: Connect() on the ingame connector interface
    _state = "docking";
    WriteStatus(_state);
}

void Undock(string name)
{
    IMyShipConnector connector = FindConnector(name);
    if (connector == null)
    {
        _state = "no-connector";
        WriteStatus(_state);
        return;
    }
    connector.Disconnect(); // VERIFY
    _state = "undocked";
    WriteStatus(_state);
}

IMyShipConnector FindConnector(string name)
{
    List<IMyShipConnector> connectors = new List<IMyShipConnector>();
    GridTerminalSystem.GetBlocksOfType(connectors, b => b.IsSameConstructAs(Me));
    for (int i = 0; i < connectors.Count; i++)
    {
        IMyShipConnector c = connectors[i];
        if (c == null || !c.IsFunctional) continue;
        if (string.IsNullOrEmpty(name) ||
            c.CustomName.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)
            return c;
    }
    return null;
}

void FindBlocks()
{
    _rc = null;
    List<IMyRemoteControl> rcs = new List<IMyRemoteControl>();
    GridTerminalSystem.GetBlocksOfType(rcs, b => b.IsSameConstructAs(Me));
    for (int i = 0; i < rcs.Count; i++)
    {
        if (rcs[i] != null && rcs[i].IsFunctional)
        {
            _rc = rcs[i];
            break;
        }
    }

    _lcd = null;
    List<IMyTextPanel> panels = new List<IMyTextPanel>();
    GridTerminalSystem.GetBlocksOfType(panels, b =>
        b.IsSameConstructAs(Me) &&
        b.CustomName.IndexOf("HERMES", StringComparison.OrdinalIgnoreCase) >= 0);
    if (panels.Count > 0) _lcd = panels[0];
}

void WriteStatus(string state)
{
    _state = state;
    if (_lcd == null) return;

    string text =
        "HERMES: READY — goal=" + _goal + "\n" +
        "id=" + _id + "  role=" + _role + "\n" +
        "state=" + _state + "  fw=" + FIRMWARE_VERSION + "\n" +
        "pos=" + FormatVec(Me.GetPosition()) + "\n" +
        "power=" + PowerText() + "\n";

    _lcd.WriteText(text); // VERIFY: IMyTextPanel.WriteText availability
}

void BroadcastStatus()
{
    string payload =
        FIRMWARE_VERSION + "|" + _id + "|" + _role + "|" + _goal + "|" + _state + "|" +
        FormatVec(Me.GetPosition()) + "|" + PowerText();

    IGC.SendBroadcastMessage(STATUS_TAG, payload, TransmissionDistance.TransmissionDistanceMax);
}

string PowerText()
{
    List<IMyBatteryBlock> batteries = new List<IMyBatteryBlock>();
    GridTerminalSystem.GetBlocksOfType(batteries, b => b.IsSameConstructAs(Me));
    double stored = 0;
    double capacity = 0;
    for (int i = 0; i < batteries.Count; i++)
    {
        if (batteries[i] == null) continue;
        stored += batteries[i].CurrentStoredPower;
        capacity += batteries[i].MaxStoredPower;
    }
    if (capacity <= 0) return "n/a";
    return ((int)(100.0 * stored / capacity)) + "%";
}

string FormatVec(Vector3D v)
{
    return ((int)v.X) + "," + ((int)v.Y) + "," + ((int)v.Z);
}

void ParseIdentity()
{
    string data = Me.CustomData != null ? Me.CustomData : "";
    _id = CustomValue(data, "HERMES_ID", _id);
    _role = CustomValue(data, "HERMES_ROLE", _role);
    _goal = CustomValue(data, "HERMES_GOAL", _goal).ToLowerInvariant();

    if (_goal != "hover" && _goal != "orbit" &&
        _goal != "interplanetary" && _goal != "crash")
    {
        _goal = "hover";
    }

    if (!string.IsNullOrEmpty(Storage))
    {
        string[] saved = Storage.Split('|');
        if (saved.Length >= 1 && saved[0].Length > 0) _id = saved[0];
        if (saved.Length >= 2 && saved[1].Length > 0) _role = saved[1];
        if (saved.Length >= 3 && saved[2].Length > 0) _goal = saved[2];
    }
}

string CustomValue(string data, string key, string fallback)
{
    string[] lines = data.Split('\n');
    for (int i = 0; i < lines.Length; i++)
    {
        string line = lines[i].Trim();
        if (line.StartsWith(key + "=", StringComparison.OrdinalIgnoreCase))
        {
            string value = line.Substring(key.Length + 1).Trim();
            if (value.Length > 0) return value;
        }
    }
    return fallback;
}
