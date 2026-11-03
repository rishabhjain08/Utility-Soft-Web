@echo off
rem Opens Utility Soft in Google Chrome (or the default browser if Chrome is not found).
set "APP=%~dp0Utility Soft.html"
for %%C in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do (
  if exist %%C (
    start "" %%C "%APP%"
    exit /b
  )
)
start "" "%APP%"
