@echo off
setlocal
cd /d "%~dp0"
node src/cli.js start
if errorlevel 1 (
  echo Bridge stopped with an error. Run setup.cmd first or see README.md.
  pause
)
