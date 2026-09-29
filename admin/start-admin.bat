@echo off
rem Este archivo quedo como acceso de compatibilidad. La logica completa
rem (verificaciones, instalacion de dependencias, deteccion de puerto
rem ocupado, etc.) ahora vive en INICIAR-PANEL-VEXLOWHQ.bat, en la
rem carpeta raiz del proyecto. El original de este archivo quedo
rem respaldado como start-admin.bat.backup-20260912 en esta misma carpeta.
cd /d "%~dp0"
call ..\INICIAR-PANEL-VEXLOWHQ.bat
