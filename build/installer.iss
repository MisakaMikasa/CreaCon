; Inno Setup script for CreaCon.
;
; Build:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\installer.iss
; Expects:  dist\CreaCon\           (pyinstaller build\creacon.spec)
;           build\CreaCon.ccx       (UXP Developer Tools -> Actions -> Package)
;
; The installer does three things, and the middle one is the point of it:
;   1. lay down the frozen app
;   2. register the Photoshop plugin via UPIA, so the user never has to
;   3. make sure WebView2 exists, since the window is nothing without it

#define AppName     "CreaCon"
#define AppVersion  "0.6.3"
#define AppExe      "CreaCon.exe"
#define Publisher   "Yu Qiao"

#define UPIA "{commoncf}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

[Setup]
AppId={{8F3A7C21-5E4D-4B6A-9C18-CREACON00001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\dist
OutputBaseFilename=CreaCon-{#AppVersion}-setup
SetupIconFile=..\assets\creacon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; The app writes only to %APPDATA% and %LOCALAPPDATA%, so it does not need
; admin at RUNTIME - but installing into Program Files does, and so does UPIA.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
LicenseFile=..\LICENSE
DisableProgramGroupPage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\CreaCon\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; At the install root, not buried in _internal - these are the two documents a
; user may actually need to read, and one of them is a licence obligation.
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
; The plugin. Kept after install so the uninstaller and a repair can reach it.
Source: "CreaCon.ccx"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
; Register the plugin with Photoshop. Adobe still shows its own "not verified"
; trust prompt, so this is not silent - it just means the user never has to
; find the file themselves.
Filename: "{#UPIA}"; Parameters: "/install ""{app}\CreaCon.ccx"""; \
  StatusMsg: "Installing the Photoshop plugin..."; Flags: waituntilterminated; \
  Check: UpiaPresent
Filename: "{app}\{#AppExe}"; Description: "Start CreaCon"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; Best effort: if Creative Cloud has been removed first, UPIA is gone and there
; is nothing to unregister. No runasoriginaluser here - it is a [Run]-only flag
Filename: "{#UPIA}"; Parameters: "/remove ""CreaCon"""; \
  Flags: runhidden skipifdoesntexist; RunOnceId: "RemovePlugin"

[Code]
function UpiaPresent: Boolean;
begin
  Result := FileExists(ExpandConstant('{#UPIA}'));
end;

// WebView2 renders the whole interface. It is part of Windows 11 and shipped
// with Edge on Windows 10, so this is close to always true - but an install
// that "succeeds" and then opens a blank window is a terrible first run.
function WebView2Present: Boolean;
var
  V: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V);
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if not WebView2Present then
  begin
    if MsgBox('CreaCon needs the Microsoft WebView2 runtime, which does not appear to be'
      + ' installed.'#13#10#13#10'Install CreaCon anyway? You can get WebView2 free from'
      + ' Microsoft, and CreaCon will work once it is present.',
      mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not UpiaPresent then
    MsgBox('The Photoshop plugin could not be installed automatically, because'
      + ' Adobe''s plugin installer was not found (it comes with the Creative Cloud'
      + ' desktop app).'#13#10#13#10'CreaCon is installed. To add the plugin, double-click'#13#10
      + ExpandConstant('{app}\CreaCon.ccx'), mbInformation, MB_OK);
end;
