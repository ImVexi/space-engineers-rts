using System;
using System.Collections.Generic;
using VRage.Game.ModAPI;
using Sandbox.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Loader-neutral surface. Torch and Pulsar/Magnetar expose different base
    /// classes and lifecycle hooks; everything else in the plugin talks to the
    /// game only through this interface.
    /// </summary>
    public interface ILoaderAdapter
    {
        /// <summary>"torch" or "pulsar" — for hello.capabilities and logs.</summary>
        string LoaderName { get; }

        void Log(string level, string message);

        /// <summary>All loaded grids. VERIFY: entity enumeration differs per loader.</summary>
        IReadOnlyList<IMyCubeGrid> GetGrids();

        IMyCubeGrid GetGridById(long entityId);

        /// <summary>Register a per-tick callback. dt is seconds since the previous tick.</summary>
        void RegisterTick(Action<double> tick);

        /// <summary>Absolute path helper; loaders may sandbox relative paths.</summary>
        string ResolvePath(string path);
    }
}
