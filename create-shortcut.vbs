Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

targetDir = "bot-distribuicao"
iconPath = "public\Icone.ico"
batPath = targetDir & "\INICIAR.bat"
lnkPath = targetDir & "\INICIAR.lnk"

' Verificar se existe
If Not fso.FolderExists(targetDir) Then
    WScript.Echo "[ERRO] Pasta " & targetDir & " nao encontrada!"
    WScript.Quit 1
End If

If Not fso.FileExists(batPath) Then
    WScript.Echo "[ERRO] Arquivo " & batPath & " nao encontrado!"
    WScript.Quit 1
End If

' Criar atalho
Set shortcut = WshShell.CreateShortcut(lnkPath)
shortcut.TargetPath = fso.GetAbsolutePathName(batPath)
shortcut.WorkingDirectory = fso.GetAbsolutePathName(targetDir)
shortcut.Description = "Iniciar Bot WhatsApp"

' Adicionar icone se existir
If fso.FileExists(iconPath) Then
    shortcut.IconLocation = fso.GetAbsolutePathName(iconPath)
End If

shortcut.Save

' Verificar se foi criado
If fso.FileExists(lnkPath) Then
    WScript.Echo "[OK] Atalho criado com sucesso!"
    WScript.Echo "Arquivo: " & lnkPath
    If fso.FileExists(iconPath) Then
        WScript.Echo "Icone: " & iconPath
    End If
    WScript.Quit 0
Else
    WScript.Echo "[ERRO] Falha ao criar atalho!"
    WScript.Quit 1
End If
