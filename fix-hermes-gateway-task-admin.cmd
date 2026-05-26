@echo off
cd /d "%~dp0"
set "SCRIPT=%~dp0fix-hermes-gateway-task-admin.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','%SCRIPT%')"
