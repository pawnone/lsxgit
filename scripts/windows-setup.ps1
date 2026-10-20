$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '文青尚品.exe'
if (!(Test-Path $exe)) { throw '请先完整解压，再运行安装快捷方式' }
$source = @'
using System;
using System.Runtime.InteropServices;
public static class WqShortcut {
 [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
 [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
 interface IShellLinkW {
 void GetPath(IntPtr a,int b,IntPtr c,int d); void GetIDList(out IntPtr a); void SetIDList(IntPtr a);
 void GetDescription(IntPtr a,int b); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string a);
 void GetWorkingDirectory(IntPtr a,int b); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string a);
 void GetArguments(IntPtr a,int b); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
 void GetHotkey(out short a); void SetHotkey(short a); void GetShowCmd(out int a); void SetShowCmd(int a);
 void GetIconLocation(IntPtr a,int b,out int c); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string a,int b);
 void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string a,int b); void Resolve(IntPtr a,int b);
 void SetPath([MarshalAs(UnmanagedType.LPWStr)] string a);
 }
 [StructLayout(LayoutKind.Sequential,Pack=4)] struct Key { public Guid fmtid; public uint pid; }
 [StructLayout(LayoutKind.Explicit,Size=24)] struct Value { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr text; }
 [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
 interface IPropertyStore { void GetCount(out uint a); void GetAt(uint a,out Key b); void GetValue(ref Key a,out Value b); void SetValue(ref Key a,ref Value b); void Commit(); }
 public static void Create(string exe,string file) {
 object obj=new ShellLink();
 try {
 var link=(IShellLinkW)obj; link.SetPath(exe); link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(exe)); link.SetDescription("文青尚品"); link.SetIconLocation(exe,0);
 var store=(IPropertyStore)obj;
 var key=new Key{fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),pid=5};
 var value=new Value{vt=31,text=Marshal.StringToCoTaskMemUni("com.wenqing.shangpin")};
 try {store.SetValue(ref key,ref value);store.Commit();} finally {Marshal.FreeCoTaskMem(value.text);}
 ((System.Runtime.InteropServices.ComTypes.IPersistFile)obj).Save(file,true);
 } finally {Marshal.FinalReleaseComObject(obj);}
 }
}
'@
Add-Type -TypeDefinition $source
$menu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\文青尚品.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) '文青尚品.lnk'
[WqShortcut]::Create($exe,$menu)
[WqShortcut]::Create($exe,$desktop)
Write-Host '快捷方式已创建。请从开始菜单打开文青尚品，并允许系统通知。'
