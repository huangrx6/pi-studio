# Persistent Windows Computer Use helper for Pi Studio.
# Speaks line-delimited UTF-8 JSON over stdin/stdout so C# Win32 + UI Automation
# types compile once per process and individual calls complete in ~10-30ms.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$csharp = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class PiWin32Desktop
{
    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int DWMWA_CLOAKED = 14;
    private const uint GW_OWNER = 4;
    private const uint GA_ROOT = 2;
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x, y; }
    public const uint PW_RENDERFULLCONTENT = 0x00000002;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint TOKEN_QUERY = 0x0008;
    public const int TokenElevation = 20;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_ELEVATION { public uint TokenIsElevated; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, out TOKEN_ELEVATION TokenInformation, int TokenInformationLength, out int ReturnLength);

    public static void InitDpi()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }
    }

    public static bool IsProcessElevated(uint pid)
    {
        IntPtr hProc = IntPtr.Zero;
        IntPtr hToken = IntPtr.Zero;
        try
        {
            hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProc == IntPtr.Zero) return false;
            if (!OpenProcessToken(hProc, TOKEN_QUERY, out hToken)) return false;
            TOKEN_ELEVATION elev;
            int len;
            if (GetTokenInformation(hToken, TokenElevation, out elev, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out len))
            {
                return elev.TokenIsElevated != 0;
            }
            return false;
        }
        catch { return false; }
        finally
        {
            if (hToken != IntPtr.Zero) CloseHandle(hToken);
            if (hProc != IntPtr.Zero) CloseHandle(hProc);
        }
    }

    public static bool IsCurrentProcessElevated()
    {
        return IsProcessElevated((uint)Process.GetCurrentProcess().Id);
    }

    public static RECT GetBounds(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
        {
            if (r.Right - r.Left > 0 && r.Bottom - r.Top > 0) return r;
        }
        GetWindowRect(hwnd, out r);
        return r;
    }

    public static bool IsCloaked(IntPtr hwnd)
    {
        try
        {
            int cloaked = 0;
            if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, Marshal.SizeOf(typeof(int))) == 0)
            {
                return cloaked != 0;
            }
        }
        catch { }
        return false;
    }

    public static string GetTitle(IntPtr hwnd)
    {
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 2);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static List<Dictionary<string, object>> EnumTopLevelWindows()
    {
        var list = new List<Dictionary<string, object>>();
        var procCache = new Dictionary<uint, Dictionary<string, object>>();
        EnumWindows((hwnd, lParam) =>
        {
            try
            {
                if (!IsWindowVisible(hwnd)) return true;
                if (IsCloaked(hwnd)) return true;
                bool minimized = IsIconic(hwnd);
                var rect = GetBounds(hwnd);
                int w = rect.Right - rect.Left;
                int h = rect.Bottom - rect.Top;
                if (!minimized && (w < 80 || h < 60)) return true;
                string title = GetTitle(hwnd);
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) return true;

                Dictionary<string, object> pinfo;
                if (!procCache.TryGetValue(pid, out pinfo))
                {
                    pinfo = new Dictionary<string, object>();
                    string procName = "";
                    string displayName = "";
                    string exePath = "";
                    string exeName = "";
                    try
                    {
                        using (var p = Process.GetProcessById((int)pid))
                        {
                            procName = p.ProcessName ?? "";
                            try
                            {
                                exePath = p.MainModule != null ? (p.MainModule.FileName ?? "") : "";
                                if (!string.IsNullOrEmpty(exePath))
                                {
                                    exeName = Path.GetFileName(exePath);
                                    var fvi = FileVersionInfo.GetVersionInfo(exePath);
                                    if (!string.IsNullOrWhiteSpace(fvi.FileDescription)) displayName = fvi.FileDescription.Trim();
                                    else if (!string.IsNullOrWhiteSpace(fvi.ProductName)) displayName = fvi.ProductName.Trim();
                                }
                            }
                            catch { }
                        }
                    }
                    catch { }
                    if (string.IsNullOrWhiteSpace(exeName) && !string.IsNullOrWhiteSpace(procName)) exeName = procName + ".exe";
                    if (string.IsNullOrWhiteSpace(displayName)) displayName = procName;
                    pinfo["processName"] = procName;
                    pinfo["displayName"] = displayName;
                    pinfo["exePath"] = exePath;
                    pinfo["exeName"] = exeName;
                    pinfo["elevated"] = IsProcessElevated(pid);
                    procCache[pid] = pinfo;
                }

                list.Add(new Dictionary<string, object>
                {
                    { "windowId", hwnd.ToInt64() },
                    { "pid", (int)pid },
                    { "title", title },
                    { "processName", pinfo["processName"] },
                    { "displayName", pinfo["displayName"] },
                    { "exeName", pinfo["exeName"] },
                    { "path", pinfo["exePath"] },
                    { "elevated", pinfo["elevated"] },
                    { "minimized", minimized },
                    { "visible", !minimized },
                    { "bounds", new Dictionary<string, object> { { "x", rect.Left }, { "y", rect.Top }, { "width", w }, { "height", h } } }
                });
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    private static bool IsOwnedSurface(IntPtr surface, IntPtr main, int pid)
    {
        uint ownerPid;
        GetWindowThreadProcessId(surface, out ownerPid);
        if (pid <= 0 || ownerPid != (uint)pid || !IsWindowVisible(surface) || IsIconic(surface) || IsCloaked(surface)) return false;
        var ancestor = surface;
        for (int i = 0; i < 16 && ancestor != IntPtr.Zero; i++)
        {
            if (ancestor == main) return true;
            ancestor = GetWindow(ancestor, GW_OWNER);
        }
        return false;
    }

    private static Dictionary<string, int> FrameBounds(RECT frame)
    {
        return new Dictionary<string, int> { { "x", frame.Left }, { "y", frame.Top },
            { "width", frame.Right - frame.Left }, { "height", frame.Bottom - frame.Top } };
    }

    public static Dictionary<string, object> CaptureWindowPng(long windowId, int pid, int maxEdge, bool includePopups, int waitMs)
    {
        var main = new IntPtr(windowId);
        var timer = Stopwatch.StartNew();
        var panels = new List<Dictionary<string, object>>();
        do
        {
            if (!IsOwnedSurface(main, main, pid)) throw new InvalidOperationException("desktop_window_mismatch");
            if (!includePopups) break;
            EnumWindows((hwnd, unused) => {
                if (hwnd == main || !IsOwnedSurface(hwnd, main, pid)) return true;
                try
                {
                    var bounds = GetBounds(hwnd);
                    var panel = CaptureWindowRegion(hwnd, Math.Min(maxEdge, 1000), bounds);
                    if (IsOwnedSurface(hwnd, main, pid) && bounds.Equals(GetBounds(hwnd)))
                    {
                        panel["windowId"] = hwnd.ToInt64();
                        panel["imageWidth"] = panel["width"];
                        panel["imageHeight"] = panel["height"];
                        panel["bounds"] = FrameBounds(bounds);
                        panels.Add(panel);
                    }
                }
                catch (InvalidOperationException) { } // The popup closed before it could paint.
                return panels.Count < 3;
            }, IntPtr.Zero);
            if (panels.Count > 0 || timer.ElapsedMilliseconds >= Math.Min(waitMs, 3000)) break;
            Thread.Sleep(60);
        } while (true);
        if (!IsOwnedSurface(main, main, pid)) throw new InvalidOperationException("desktop_window_mismatch");
        var frame = GetBounds(main);
        var shot = CaptureWindowRegion(main, maxEdge, frame);
        if (!IsOwnedSurface(main, main, pid) || !frame.Equals(GetBounds(main))) throw new InvalidOperationException("desktop_window_mismatch");
        shot["bounds"] = FrameBounds(frame);
        shot["panels"] = panels;
        return shot;
    }

    private static Dictionary<string, object> CaptureWindowRegion(IntPtr hwnd, int maxEdge, RECT clip)
    {
        RECT full;
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd) || !GetWindowRect(hwnd, out full))
            throw new InvalidOperationException("desktop_window_not_visible");
        // PrintWindow paints the full HWND, including any invisible resize border.
        // Crop in screen coordinates so the resulting pixels match the reported DWM bounds.
        var frame = Rectangle.FromLTRB(full.Left, full.Top, full.Right, full.Bottom);
        var region = Rectangle.Intersect(frame, Rectangle.FromLTRB(clip.Left, clip.Top, clip.Right, clip.Bottom));
        if (region.Width <= 0 || region.Height <= 0) throw new InvalidOperationException("desktop_window_not_visible");
        using (var bmp = new Bitmap(frame.Width, frame.Height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                try { if (!PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)) throw new InvalidOperationException("desktop_screenshot_failed"); }
                finally { g.ReleaseHdc(hdc); }
            }
            double ratio = maxEdge > 0 ? Math.Min(1.0, (double)maxEdge / Math.Max(region.Width, region.Height)) : 1.0;
            int w = Math.Max(1, (int)Math.Round(region.Width * ratio)), h = Math.Max(1, (int)Math.Round(region.Height * ratio));
            region.Offset(-frame.Left, -frame.Top);
            using (var output = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            using (var ms = new MemoryStream())
            {
                using (var g = Graphics.FromImage(output))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(bmp, new Rectangle(0, 0, w, h), region, GraphicsUnit.Pixel);
                }
                output.Save(ms, ImageFormat.Png);
                var bytes = ms.ToArray();
                return new Dictionary<string, object> {
                    { "data", Convert.ToBase64String(bytes) }, { "mimeType", "image/png" }, { "bytes", bytes.Length },
                    { "scaled", ratio < 1.0 }, { "width", w }, { "height", h }
                };
            }
        }
    }

    private static bool IsSecureElement(AutomationElement el)
    {
        try { if (el.Current.IsPassword) return true; } catch { }
        try
        {
            string name = (el.Current.Name ?? "").ToLowerInvariant();
            string help = (el.Current.HelpText ?? "").ToLowerInvariant();
            if (name.Contains("password") || help.Contains("password")) return true;
        }
        catch { }
        return false;
    }

    private static string SafeValue(AutomationElement el, bool secure)
    {
        if (secure) return "";
        try
        {
            object patternObj;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out patternObj))
            {
                var vp = patternObj as ValuePattern;
                if (vp != null && vp.Current.Value != null) return vp.Current.Value;
            }
        }
        catch { }
        return "";
    }

    private static Dictionary<string, object> SafeBounds(AutomationElement el)
    {
        try
        {
            var r = el.Current.BoundingRectangle;
            if (double.IsInfinity(r.Left) || double.IsNaN(r.Left) || r.Width <= 0 || r.Height <= 0) return null;
            return new Dictionary<string, object>
            {
                { "x", (int)Math.Round(r.Left) },
                { "y", (int)Math.Round(r.Top) },
                { "width", (int)Math.Round(r.Width) },
                { "height", (int)Math.Round(r.Height) }
            };
        }
        catch { return null; }
    }

    public static Dictionary<string, object> SnapshotWindow(long hwndLong, int maxNodes)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (!IsWindow(hwnd)) throw new Exception("window_not_found");
        var root = AutomationElement.FromHandle(hwnd);
        if (root == null) throw new Exception("window_not_found");

        var nodes = new List<Dictionary<string, object>>();
        bool truncated = false;
        var walker = TreeWalker.ControlViewWalker;
        WalkElement(walker, root, 0, "1", maxNodes, nodes, ref truncated);

        return new Dictionary<string, object>
        {
            { "windowId", hwndLong },
            { "title", GetTitle(hwnd) },
            { "nodes", nodes },
            { "truncated", truncated }
        };
    }

    private static void WalkElement(
        TreeWalker walker,
        AutomationElement el,
        int depth,
        string path,
        int maxNodes,
        List<Dictionary<string, object>> nodes,
        ref bool truncated)
    {
        if (el == null) return;
        if (depth > 24) { truncated = true; return; }
        if (nodes.Count >= maxNodes) { truncated = true; return; }
        string role = "";
        string name = "";
        string desc = "";
        bool secure = IsSecureElement(el);
        try { role = el.Current.ControlType != null ? (el.Current.ControlType.ProgrammaticName ?? "") : ""; } catch { }
        try { name = el.Current.Name ?? ""; } catch { }
        try { desc = el.Current.HelpText ?? ""; } catch { }
        string val = SafeValue(el, secure);
        var bounds = SafeBounds(el);
        if (!string.IsNullOrEmpty(role) || !string.IsNullOrEmpty(name) || !string.IsNullOrEmpty(val) || bounds != null)
        {
            var node = new Dictionary<string, object>
            {
                { "ref", "n" + (nodes.Count + 1) },
                { "role", role },
                { "name", name },
                { "value", val },
                { "description", desc },
                { "depth", depth },
                { "path", path },
                { "bounds", bounds },
                { "secure", secure }
            };
            nodes.Add(node);
        }

        AutomationElement child = null;
        try { child = walker.GetFirstChild(el); } catch { child = null; truncated = true; }
        int index = 0;
        while (child != null)
        {
            if (nodes.Count >= maxNodes) { truncated = true; break; }
            index++;
            string childPath = string.IsNullOrEmpty(path) ? index.ToString() : (path + "/" + index);
            WalkElement(walker, child, depth + 1, childPath, maxNodes, nodes, ref truncated);
            try { child = walker.GetNextSibling(child); } catch { child = null; truncated = true; }
        }
    }

    public static Dictionary<string, object> GetFocusedInfo(long windowId)
    {
        var hwnd = new IntPtr(windowId);
        RequireForeground(windowId);
        var el = AutomationElement.FocusedElement;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (el == null || el.Current.ProcessId != (int)pid)
            throw new InvalidOperationException("desktop_focus_required");
        return new Dictionary<string, object> { { "secure", IsSecureElement(el) } };
    }

    private static void ToAbsoluteCoords(int x, int y, out int absX, out int absY)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        absX = (int)Math.Round(((double)(x - vx) * 65535.0) / Math.Max(1, vw - 1));
        absY = (int)Math.Round(((double)(y - vy) * 65535.0) / Math.Max(1, vh - 1));
    }

    private static void RequireForeground(long hwndLong)
    {
        var hwnd = new IntPtr(hwndLong);
        if (hwnd == IntPtr.Zero || GetForegroundWindow() != hwnd || IsIconic(hwnd))
            throw new InvalidOperationException("desktop_foreground_required");
    }

    private static void RequirePoint(long hwndLong, int x, int y)
    {
        RequireForeground(hwndLong);
        IntPtr hit = WindowFromPoint(new POINT { x = x, y = y });
        if (hit == IntPtr.Zero || GetAncestor(hit, GA_ROOT).ToInt64() != hwndLong)
            throw new InvalidOperationException("desktop_target_occluded");
    }

    private static void SendMouse(uint flags, int x, int y, uint mouseData)
    {
        int ax, ay;
        ToAbsoluteCoords(x, y, out ax, out ay);
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.dx = ax;
        inp[0].U.mi.dy = ay;
        inp[0].U.mi.mouseData = mouseData;
        inp[0].U.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void ClickAt(long hwndLong, int x, int y, string button)
    {
        ClickChecked(x, y, button, () => RequirePoint(hwndLong, x, y));
    }

    public static void ClickPopup(long windowId, int pid, long popupId, int left, int top, int width, int height, int x, int y, string button)
    {
        var main = new IntPtr(windowId);
        var popup = new IntPtr(popupId);
        ClickChecked(x, y, button, () => {
            var bounds = GetBounds(popup);
            var foreground = GetForegroundWindow();
            var hit = WindowFromPoint(new POINT { x = x, y = y });
            if (popup == main || !IsOwnedSurface(main, main, pid) || !IsOwnedSurface(popup, main, pid) ||
                (foreground != main && foreground != popup) || GetAncestor(hit, GA_ROOT) != popup ||
                bounds.Left != left || bounds.Top != top || bounds.Right - left != width || bounds.Bottom - top != height ||
                x < bounds.Left || x >= bounds.Right || y < bounds.Top || y >= bounds.Bottom)
                throw new InvalidOperationException("desktop_popup_changed");
        });
    }

    private static void ClickChecked(int x, int y, string button, Action check)
    {
        check();
        SendMouse(MOUSEEVENTF_MOVE, x, y, 0);
        Thread.Sleep(15);
        check();
        bool right = string.Equals(button, "right", StringComparison.OrdinalIgnoreCase);
        SendMouse(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN, x, y, 0);
        Thread.Sleep(20);
        SendMouse(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP, x, y, 0);
    }

    public static void ScrollAt(long hwndLong, int x, int y, int dx, int dy)
    {
        RequirePoint(hwndLong, x, y);
        SendMouse(MOUSEEVENTF_MOVE, x, y, 0);
        Thread.Sleep(15);
        RequirePoint(hwndLong, x, y);
        if (dy != 0)
        {
            SendMouse(MOUSEEVENTF_WHEEL, x, y, unchecked((uint)(dy * 120)));
        }
        if (dx != 0)
        {
            SendMouse(MOUSEEVENTF_HWHEEL, x, y, unchecked((uint)(dx * 120)));
        }
    }

    public static void DragBetween(long hwndLong, int x1, int y1, int x2, int y2, int steps)
    {
        RequirePoint(hwndLong, x1, y1);
        RequirePoint(hwndLong, x2, y2);
        int count = Math.Max(1, Math.Min(40, steps));
        SendMouse(MOUSEEVENTF_MOVE, x1, y1, 0);
        RequirePoint(hwndLong, x1, y1);
        SendMouse(MOUSEEVENTF_LEFTDOWN, x1, y1, 0);
        try
        {
            for (int i = 1; i <= count; i++)
            {
                double fraction = (double)i / count;
                int x = (int)Math.Round(x1 + (x2 - x1) * fraction);
                int y = (int)Math.Round(y1 + (y2 - y1) * fraction);
                RequirePoint(hwndLong, x, y);
                SendMouse(MOUSEEVENTF_MOVE, x, y, 0);
                Thread.Sleep(8);
            }
        }
        finally { SendMouse(MOUSEEVENTF_LEFTUP, 0, 0, 0); }
    }

    public static void TypeUnicode(long hwndLong, string text)
    {
        RequireForeground(hwndLong);
        if (string.IsNullOrEmpty(text)) return;
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            RequireForeground(hwndLong);
            var pair = new INPUT[2];
            pair[0].type = INPUT_KEYBOARD;
            pair[0].U.ki.wScan = (ushort)ch;
            pair[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
            pair[1].type = INPUT_KEYBOARD;
            pair[1].U.ki.wScan = (ushort)ch;
            pair[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(4);
        }
    }

    private static void SendVk(ushort vk, bool keyUp)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].U.ki.wVk = vk;
        inp[0].U.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendHotkey(long hwndLong, ushort keyVk, ushort[] modifierVks)
    {
        RequireForeground(hwndLong);
        if (modifierVks != null)
        {
            for (int i = 0; i < modifierVks.Length; i++) SendVk(modifierVks[i], false);
        }
        SendVk(keyVk, false);
        Thread.Sleep(20);
        SendVk(keyVk, true);
        if (modifierVks != null)
        {
            for (int i = modifierVks.Length - 1; i >= 0; i--) SendVk(modifierVks[i], true);
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies @(
    'System',
    'System.Core',
    'System.Drawing',
    'System.Windows.Forms',
    'UIAutomationClient',
    'UIAutomationTypes',
    'WindowsBase'
)

[PiWin32Desktop]::InitDpi()

function Get-InstalledAppMappings {
    $seen = @{}
    $results = New-Object System.Collections.ArrayList

    # 1. Start Menu shortcuts (.lnk) — best source for localized display names + real .exe paths.
    $shell = $null
    try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }
    $menuDirs = @(
        [Environment]::GetFolderPath('CommonPrograms'),
        [Environment]::GetFolderPath('Programs')
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($dir in $menuDirs) {
        try {
            $links = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
            foreach ($lnk in $links) {
                if (-not $shell) { continue }
                try {
                    $sc = $shell.CreateShortcut($lnk.FullName)
                    $target = [string]$sc.TargetPath
                    if (-not $target -or -not $target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { continue }
                    if (-not (Test-Path $target)) { continue }
                    $exeName = [System.IO.Path]::GetFileName($target)
                    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($target)
                    $displayName = [System.IO.Path]::GetFileNameWithoutExtension($lnk.Name)
                    $key = $target.ToLowerInvariant()
                    if ($seen.ContainsKey($key)) { continue }
                    $seen[$key] = $true
                    [void]$results.Add(@{
                        name = $baseName
                        displayName = $displayName
                        bundleId = $exeName.ToLowerInvariant()
                        executableName = $exeName
                        path = $target
                    })
                } catch {}
            }
        } catch {}
    }

    # 2. UWP / Start Apps (Calculator, Notepad, Settings, Store apps) via Get-StartApps.
    try {
        $startApps = Get-StartApps -ErrorAction SilentlyContinue
        foreach ($sa in $startApps) {
            $appId = [string]$sa.AppID
            $title = [string]$sa.Name
            if (-not $appId -or -not $title) { continue }
            $key = $appId.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            # Skip already-captured Win32 paths
            if ($appId.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and $seen.ContainsKey($appId.ToLowerInvariant())) { continue }
            $seen[$key] = $true
            $isPath = $appId.Contains('\') -and (Test-Path $appId)
            $exeName = if ($isPath) { [System.IO.Path]::GetFileName($appId) } else { $appId }
            $baseName = if ($isPath) { [System.IO.Path]::GetFileNameWithoutExtension($appId) } else { $title }
            [void]$results.Add(@{
                name = $baseName
                displayName = $title
                bundleId = $appId
                executableName = $exeName
                path = if ($isPath) { $appId } else { '' }
            })
        }
    } catch {}

    return $results
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }

    $req = $null
    try {
        $req = $trimmed | ConvertFrom-Json
    } catch {
        Write-Output '{"id":"","ok":false,"error":"invalid_json"}'
        continue
    }

    $id = [string]$req.id
    $action = [string]$req.action
    $p = $req.params

    try {
        $data = $null
        switch ($action) {
            'ping' {
                $data = @{ ok = $true; elevated = [PiWin32Desktop]::IsCurrentProcessElevated() }
            }
            'installed_mappings' {
                $data = Get-InstalledAppMappings
            }
            'list_windows' {
                $data = [PiWin32Desktop]::EnumTopLevelWindows()
            }
            'snapshot' {
                $maxNodes = if ($p.maxNodes) { [int]$p.maxNodes } else { 80 }
                $data = [PiWin32Desktop]::SnapshotWindow([long]$p.windowId, $maxNodes)
            }
            'screenshot' {
                $maxEdge = if ($p.maxEdge) { [int]$p.maxEdge } else { 1600 }
                $data = [PiWin32Desktop]::CaptureWindowPng([long]$p.windowId, [int]$p.pid, $maxEdge, [bool]$p.includePopups, [int]$p.popupWaitMs)
            }
            'focused' {
                $data = [PiWin32Desktop]::GetFocusedInfo([long]$p.windowId)
            }
            'click' {
                if ($p.popupWindowId) {
                    $b = $p.popupBounds
                    [PiWin32Desktop]::ClickPopup([long]$p.windowId, [int]$p.pid, [long]$p.popupWindowId,
                        [int]$b.x, [int]$b.y, [int]$b.width, [int]$b.height, [int]$p.x, [int]$p.y, [string]$p.button)
                } else {
                    [PiWin32Desktop]::ClickAt([long]$p.windowId, [int]$p.x, [int]$p.y, [string]$p.button)
                }
                $data = @{ ok = $true }
            }
            'type' {
                [PiWin32Desktop]::TypeUnicode([long]$p.windowId, [string]$p.text)
                $data = @{ ok = $true }
            }
            'scroll' {
                [PiWin32Desktop]::ScrollAt([long]$p.windowId, [int]$p.x, [int]$p.y, [int]$p.dx, [int]$p.dy)
                $data = @{ ok = $true }
            }
            'drag' {
                [PiWin32Desktop]::DragBetween([long]$p.windowId, [int]$p.x1, [int]$p.y1, [int]$p.x2, [int]$p.y2, [int]$p.steps)
                $data = @{ ok = $true }
            }
            'hotkey' {
                $mods = @()
                if ($p.modifierVks) {
                    foreach ($m in $p.modifierVks) { $mods += [uint16]$m }
                }
                [PiWin32Desktop]::SendHotkey([long]$p.windowId, [uint16]$p.keyVk, [uint16[]]$mods)
                $data = @{ ok = $true }
            }
            'launch' {
                $targetPath = [string]$p.path
                $targetBundle = [string]$p.bundleId
                $targetName = [string]$p.name
                if ($targetPath -and (Test-Path $targetPath)) {
                    Start-Process -FilePath $targetPath
                } elseif ($targetBundle -and $targetBundle.Contains('!')) {
                    Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$targetBundle"
                } elseif ($targetBundle) {
                    Start-Process -FilePath $targetBundle
                } elseif ($targetName) {
                    Start-Process -FilePath $targetName
                } else {
                    throw 'invalid_launch_target'
                }
                $data = @{ ok = $true }
            }
            default {
                throw "unknown_action:$action"
            }
        }
        $resp = @{ id = $id; ok = $true; result = $data } | ConvertTo-Json -Depth 12 -Compress
        Write-Output $resp
    } catch {
        $msg = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { [string]$_ }
        $failure = @{ id = $id; ok = $false; error = $msg }
        $leaf = $_.Exception.GetBaseException().Message
        if ($leaf -match '^desktop_[a-z_]+$') { $failure.code = $leaf }
        $resp = $failure | ConvertTo-Json -Depth 4 -Compress
        Write-Output $resp
    }
}
