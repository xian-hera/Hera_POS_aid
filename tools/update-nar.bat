@echo off
setlocal EnableDelayedExpansion
rem ============================================================================
rem  Update the unit number check data (Statistics Canada National Address Register)
rem
rem  1. Download the newest zip (about 1.6 GB) from:
rem     https://www150.statcan.gc.ca/n1/pub/46-26-0002/462600022022001-eng.htm
rem     (section "Reference period": the most recent one, e.g. 202606.zip)
rem  2. Drag the zip onto this file, or run:  tools\update-nar.bat "D:\Downloads\202612.zip"
rem
rem  It unzips, refines, rebuilds data\, tests the addresses in tools\nar-test-addresses.txt
rem  (if present), then asks before committing and pushing (Render deploys after the push).
rem ============================================================================

cd /d "%~dp0.."
set "ZIP=%~1"
if "%ZIP%"=="" (
  echo Opening the NAR download page. Download the newest zip, then drag it onto tools\update-nar.bat
  start "" "https://www150.statcan.gc.ca/n1/pub/46-26-0002/462600022022001-eng.htm"
  pause
  exit /b 1
)
if not exist "%ZIP%" ( echo File not found: %ZIP% & pause & exit /b 1 )

set "WORK=%~dpn1_work"
echo.
echo [1/5] Unzipping %~nx1 to %WORK% (several minutes)...
if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%"
tar -xf "%ZIP%" -C "%WORK%"
if errorlevel 1 ( echo Unzip failed. & pause & exit /b 1 )

set "ADDR="
for /f "delims=" %%D in ('dir /s /b /ad "%WORK%\*Address*" 2^>nul') do if not defined ADDR set "ADDR=%%D"
if not defined ADDR ( echo No "Addresses" folder found inside the zip. & pause & exit /b 1 )
echo     Addresses folder: !ADDR!

echo.
echo [2/5] Refining (one small CSV per province)...
node tools\nar-refine.js "!ADDR!" "%WORK%\NAR_refined"
if errorlevel 1 ( echo nar-refine failed. & pause & exit /b 1 )

echo.
echo [3/5] Building data\nar-all.bin.gz and data\nar-multi.tsv.gz...
node tools\nar-index.js "%WORK%\NAR_refined"
if errorlevel 1 ( echo nar-index failed. & pause & exit /b 1 )

echo.
if exist "tools\nar-test-addresses.txt" (
  echo [4/5] Checking the known returned addresses ^(tools\nar-test-addresses.txt^)...
  node tools\nar-batch.js "%WORK%\NAR_refined" tools\nar-test-addresses.txt
) else (
  echo [4/5] No tools\nar-test-addresses.txt: test skipped.
)

echo.
echo [5/5] Changes:
git status --short data
echo.
choice /c YN /m "Commit and push data\ now (Render deploys automatically)"
if errorlevel 2 (
  echo Not pushed. When ready:  git add data ^&^& git commit -m "NAR update %~n1" ^&^& git push
) else (
  git add data
  git commit -m "NAR update %~n1"
  git push
)

echo.
choice /c YN /m "Delete the unzipped work folder %WORK% (several GB)"
if errorlevel 2 ( echo Kept: %WORK% ) else ( rmdir /s /q "%WORK%" & echo Deleted. )
echo.
echo Done. After Render deploys, its log should show: [nar] loaded ... civic addresses
pause
