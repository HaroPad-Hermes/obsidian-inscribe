@echo off
REM Deploy built plugin files into the Obsidian vault's inscribe plugin folder.
REM Run after `npm run build` so Obsidian picks up the new build on plugin reload.
set "VAULT_PLUGIN=C:\Users\HaroPad_\Documents\Obsidian Vault\.obsidian\plugins\inscribe"
copy /Y main.js "%VAULT_PLUGIN%\main.js" >nul
copy /Y manifest.json "%VAULT_PLUGIN%\manifest.json" >nul
copy /Y styles.css "%VAULT_PLUGIN%\styles.css" >nul
echo Deployed to %VAULT_PLUGIN%
