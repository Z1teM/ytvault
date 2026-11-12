@echo off
setlocal
cd /d "%~dp0"

rem Версия Node.js, которая скачивается при первом запуске.
rem Хочешь другую — поменяй NODE_VER (папка runtime перекачается сама).
set "NODE_VER=26.13.0"
set "RUNTIME=runtime"
set "NODE_EXE=%RUNTIME%\node.exe"
set "ZIP=%TEMP%\node-v%NODE_VER%-win-x64.zip"
set "URL=https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"

if exist "%NODE_EXE%" goto run

echo [1/3] Node.js не найден в папке проекта — скачиваю v%NODE_VER% (около 40 МБ).
echo       Это делается один раз, дальше запуск будет мгновенным.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; if (!(Test-Path '%ZIP%')) { Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%' -UseBasicParsing }; $tmp = Join-Path $env:TEMP 'ytvault-node-unpack'; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive -Path '%ZIP%' -DestinationPath $tmp -Force; if (Test-Path '%RUNTIME%') { Remove-Item '%RUNTIME%' -Recurse -Force }; Move-Item (Join-Path $tmp 'node-v%NODE_VER%-win-x64') '%RUNTIME%'"

if not exist "%NODE_EXE%" goto fallback

:run
set "PATH=%CD%\%RUNTIME%;%PATH%"

if not exist "node_modules\express" (
  echo [2/3] Устанавливаю зависимости: npm install...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto depsfail
) else (
  echo [2/3] Зависимости уже установлены.
)

echo [3/3] Vault запущен: http://localhost:3000
echo       Закрой это окно, чтобы остановить сервер.
if not defined YTVAULT_NO_BROWSER start "" http://localhost:3000
node server.js
goto end

:fallback
where node >nul 2>nul
if errorlevel 1 goto nodownload
echo.
echo Скачать Node.js не удалось, использую установленный в системе.
goto run

:nodownload
echo.
echo Не удалось скачать Node.js.
echo Проверь интернет или поставь Node.js вручную: https://nodejs.org
pause
exit /b 1

:depsfail
echo.
echo npm install завершился с ошибкой.
echo Обычно помогает удалить папку node_modules и запустить start.bat заново.
pause
exit /b 1

:end
endlocal
