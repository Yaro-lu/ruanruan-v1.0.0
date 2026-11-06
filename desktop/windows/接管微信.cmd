@echo off
setlocal
title Ruanruan WeChat
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-wechat.ps1"
if errorlevel 1 pause
