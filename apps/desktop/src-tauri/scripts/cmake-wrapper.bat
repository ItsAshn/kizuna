@echo off
setlocal enabledelayedexpansion

rem Find the real cmake.exe on PATH
set "REAL_CMAKE="
for /f "delims=" %%i in ('where cmake 2^>nul') do set "REAL_CMAKE=%%i"
if defined REAL_CMAKE (
    "!REAL_CMAKE!" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 %*
    exit /b !ERRORLEVEL!
)
echo ERROR: cmake.exe not found in PATH
exit /b 1
