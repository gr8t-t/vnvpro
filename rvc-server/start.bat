@echo off
echo =============================================
echo  VNV Pro RVC Voice Conversion Server
echo =============================================
echo.
echo Make sure you have installed requirements:
echo   pip install -r requirements.txt
echo.
echo Starting server on port 8765...
echo.
echo To expose publicly via ngrok, open another terminal and run:
echo   ngrok http 8765
echo.
echo Then paste the ngrok HTTPS URL into the Admin panel ^> Settings ^> RVC Server URL
echo.
python server.py
pause
