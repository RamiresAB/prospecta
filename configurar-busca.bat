@echo off
rem Guarda a chave do Serper (busca do Google) neste PC. A chave nao vai para o Obsidian nem para o chat.
cd /d "%~dp0"
echo.
echo Cole a chave do Serper e aperte Enter.
echo (Ela fica so neste PC, no arquivo chave-serper.txt.)
echo.
set /p CHAVE=Chave:
if "%CHAVE%"=="" (
  echo Nenhuma chave informada. Nada foi salvo.
  pause
  exit /b 1
)
>chave-serper.txt (echo %CHAVE%)
echo.
echo Chave salva. Feche o Prospecta (se estiver aberto) e abra de novo pelo atalho.
pause
