@echo off
rem Liga o motor (se o Docker estiver ativo) e abre o Prospecta no navegador.
cd /d "%~dp0"
where docker >nul 2>&1 && docker info >nul 2>&1 && docker compose up -d
node iniciar-prospecta.js
pause
