using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;
using IMyThrust = Sandbox.ModAPI.IMyThrust;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Geometric thruster classification, for hulls where the engine reports
    /// `GridThrustDirection = (0,0,0)`.
    ///
    /// Measured problem: SAT-R-0002 (grid:94562719844060513) reports 12 lift
    /// thrusters with axis (0,0,0), so `profile.thrustPerDirection` showed upN=0
    /// and the level controller refused a hull that clearly has lift. The block's
    /// world matrix is always readable, so the axis can be derived from geometry.
    ///
    /// The block-to-thrust-axis convention is NOT assumed. The classifier first
    /// calibrates against every thruster on the same grid whose
    /// `GridThrustDirection` IS readable: it tries all six block-local axes and
    /// keeps the one whose grid-local rounding matches the engine's reported
    /// values. If no thruster reports a direction, geometry is still applied but
    /// flagged `calibrated:false` so nobody reads it as engine-confirmed.
    /// </summary>
    public static class ThrusterGeometry
    {
        public sealed class Axis
        {
            public string Name;
            public Vector3I GridAxis;
            public bool Reported;
            public string Source;      // reported | geometry | geometry-uncalibrated
            public double ThrustN;
            public IMyThrust Thruster;
        }

        public sealed class Classification
        {
            public List<Axis> Thrusters = new List<Axis>();
            public int ReportedCount;
            public int DerivedCount;
            public bool Calibrated;
            public string CalibrationAxis;   // block-local axis name that matched
            public int CalibrationMatches;
            public int CalibrationSamples;
            public string Note;
        }

        private static readonly string[] BlockAxes = { "Forward", "Backward", "Up", "Down", "Left", "Right" };

        private static Vector3 LocalAxis(MatrixD m, string name)
        {
            switch (name)
            {
                case "Forward": return m.Forward;
                case "Backward": return m.Backward;
                case "Up": return m.Up;
                case "Down": return m.Down;
                case "Left": return m.Left;
                default: return m.Right;
            }
        }

        private static Vector3I ToGridAxis(Vector3 worldAxis, MatrixD gridMatrix)
        {
            var local = Vector3D.TransformNormal(new Vector3D(worldAxis), MatrixD.Transpose(gridMatrix));
            // Round to the dominant unit axis; anything else is not a valid
            // thruster mount and gets reported as (0,0,0) honestly.
            var ax = Math.Abs(local.X) >= Math.Abs(local.Y) && Math.Abs(local.X) >= Math.Abs(local.Z) ? 0
                : Math.Abs(local.Y) >= Math.Abs(local.Z) ? 1 : 2;
            var sign = ax == 0 ? Math.Sign(local.X) : ax == 1 ? Math.Sign(local.Y) : Math.Sign(local.Z);
            if (sign == 0) return Vector3I.Zero;
            // The mount must be axis-aligned; a diagonal block is not a thruster
            // orientation we can classify, so report it as unknown.
            var magnitude = Math.Abs(ax == 0 ? local.X : ax == 1 ? local.Y : local.Z);
            var off = (local - (ax == 0 ? new Vector3D(local.X, 0, 0) : ax == 1 ? new Vector3D(0, local.Y, 0) : new Vector3D(0, 0, local.Z))).Length();
            if (off > magnitude * 0.15) return Vector3I.Zero;
            return ax == 0 ? new Vector3I(sign, 0, 0) : ax == 1 ? new Vector3I(0, sign, 0) : new Vector3I(0, 0, sign);
        }

        public static Classification Classify(IMyCubeGrid grid)
        {
            var result = new Classification();
            var gridMatrix = grid.WorldMatrix;

            var all = new List<IMyThrust>();
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr != null) all.Add(thr);
            }

            // --- calibration pass -------------------------------------------------
            var bestAxis = "Backward";
            var bestMatches = 0;
            var samples = 0;
            foreach (var thr in all)
            {
                Vector3I reported;
                try { reported = thr.GridThrustDirection; } catch { continue; }
                if (reported == Vector3I.Zero) continue;
                samples++;
            }
            // Score each block axis against what the engine reported.
            foreach (var axisName in BlockAxes)
            {
                var matches = 0;
                foreach (var thr in all)
                {
                    Vector3I reported;
                    try { reported = thr.GridThrustDirection; } catch { continue; }
                    if (reported == Vector3I.Zero) continue;
                    if (ToGridAxis(LocalAxis(thr.WorldMatrix, axisName), gridMatrix) == reported) matches++;
                }
                if (matches > bestMatches)
                {
                    bestMatches = matches;
                    bestAxis = axisName;
                }
            }

            result.Calibrated = samples > 0 && bestMatches > 0;
            result.CalibrationAxis = result.Calibrated ? bestAxis : null;
            result.CalibrationMatches = bestMatches;
            result.CalibrationSamples = samples;

            // --- classification pass ---------------------------------------------
            foreach (var thr in all)
            {
                Vector3I reported = Vector3I.Zero;
                var read = true;
                try { reported = thr.GridThrustDirection; } catch { read = false; }

                double thrust = 0;
                try { thrust = thr.MaxEffectiveThrust; } catch { }

                var axis = new Axis { Thruster = thr, ThrustN = thrust };
                if (!read)
                {
                    axis.GridAxis = Vector3I.Zero;
                    axis.Source = "unreadable";
                    axis.Name = SafeName(thr);
                    result.Thrusters.Add(axis);
                    continue;
                }
                if (reported != Vector3I.Zero)
                {
                    axis.GridAxis = reported;
                    axis.Reported = true;
                    axis.Source = "reported";
                    result.ReportedCount++;
                }
                else
                {
                    axis.GridAxis = ToGridAxis(LocalAxis(thr.WorldMatrix, bestAxis), gridMatrix);
                    axis.Reported = false;
                    axis.Source = result.Calibrated ? "geometry" : "geometry-uncalibrated";
                    result.DerivedCount++;
                }
                axis.Name = SafeName(thr);
                result.Thrusters.Add(axis);
            }

            if (all.Count == 0) result.Note = "no thrusters";
            else if (result.DerivedCount > 0 && !result.Calibrated)
                result.Note = "engine reported (0,0,0) for every thruster and no readable thruster existed to calibrate against; axes are geometric and unconfirmed";
            else if (result.DerivedCount > 0)
                result.Note = "derived from block orientation, calibrated against " + bestMatches + "/" + samples +
                    " readable thrusters using the block's " + bestAxis + " axis";
            else result.Note = "every thruster reported its own GridThrustDirection";

            return result;
        }

        public static JArray ToJson(Classification c)
        {
            var arr = new JArray();
            foreach (var a in c.Thrusters)
            {
                arr.Add(new JObject
                {
                    ["name"] = a.Name,
                    ["axis"] = a.GridAxis.X + "," + a.GridAxis.Y + "," + a.GridAxis.Z,
                    ["source"] = a.Source,
                    ["thrustN"] = Math.Round(a.ThrustN, 0),
                });
            }
            return arr;
        }

        private static string SafeName(IMyThrust thr)
        {
            try
            {
                var terminal = thr as IMyTerminalBlock;
                return terminal != null ? (terminal.CustomName ?? "") : "";
            }
            catch { return ""; }
        }

        public static string AxisName(Vector3I axis)
        {
            if (axis == new Vector3I(0, 1, 0)) return "up";
            if (axis == new Vector3I(0, -1, 0)) return "down";
            if (axis == new Vector3I(0, 0, -1)) return "fwd";
            if (axis == new Vector3I(0, 0, 1)) return "back";
            if (axis == new Vector3I(-1, 0, 0)) return "left";
            if (axis == new Vector3I(1, 0, 0)) return "right";
            return "unknown";
        }
    }
}
