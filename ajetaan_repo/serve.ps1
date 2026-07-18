# Ääretön Tie - käynnistys HTTP-palvelimella (vaatii 3D-mallin latausta varten)
$port = 8080
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Käynnistetään peli osoitteessa http://localhost:$port" -ForegroundColor Cyan
Write-Host "Paina Ctrl+C sulkeaksesi" -ForegroundColor Gray
Start-Process "http://localhost:$port"
python -m http.server $port -d $dir
