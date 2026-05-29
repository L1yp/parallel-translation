# pack.ps1 —— 把扩展打包成 zip，方便分发 / 上传 Chrome Web Store
#
# 用法：
#   右键「使用 PowerShell 运行」，或在仓库根目录执行：
#     powershell -ExecutionPolicy Bypass -File .\pack.ps1
#
# 产物：dist\对照式翻译-v<版本号>.zip
#
# 设计：白名单式打包 —— 只收录扩展运行真正需要的文件，
# 绝不误带 .git / .idea / .claude / CLAUDE.md / docs / 凭证等。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# --- 要打包的顶层文件（扩展运行时实际加载的）---
$files = @(
    'manifest.json',
    'background.js',
    'cache.js',
    'vocab.js',
    'content.js',
    'content.css',
    'options.html',
    'options.js',
    'popup.html',
    'popup.js'
)

# --- 要打包的目录（按白名单收录其中文件，见下）---
# providers: 全部 .js
# icons:     仅 manifest 引用的 4 张 png（排除源图 img.png）
$dirs = @{
    'providers' = @('*.js')
    'icons'     = @('icon16.png', 'icon32.png', 'icon48.png', 'icon128.png')
}

# --- 从 manifest.json 读版本号，用于 zip 命名 ---
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = $manifest.version
$name = $manifest.name

# --- 准备一个干净的临时暂存目录 ---
$dist = Join-Path $root 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

$stage = Join-Path $dist '_stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

# --- 拷贝顶层文件到暂存区 ---
foreach ($f in $files) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) { throw "缺少文件: $f" }
    Copy-Item $src -Destination $stage
}

# --- 拷贝目录（按白名单）---
foreach ($d in $dirs.Keys) {
    $srcDir = Join-Path $root $d
    if (-not (Test-Path $srcDir)) { throw "缺少目录: $d" }
    $dstDir = Join-Path $stage $d
    New-Item -ItemType Directory -Path $dstDir | Out-Null
    foreach ($pat in $dirs[$d]) {
        Get-ChildItem -Path $srcDir -Filter $pat -File | ForEach-Object {
            Copy-Item $_.FullName -Destination $dstDir
        }
    }
}

# --- 打包成 zip ---
$zipName = "$name-v$version.zip"
$zipPath = Join-Path $dist $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# 用 stage 目录内容做根（zip 里直接是 manifest.json 而非多一层目录）
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -Force

# --- 清理暂存区 ---
Remove-Item $stage -Recurse -Force

# --- 报告 ---
$sizeKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host ""
Write-Host "✅ 打包完成" -ForegroundColor Green
Write-Host "   文件: $zipPath"
Write-Host "   大小: $sizeKB KB"
Write-Host ""
Write-Host "分发说明：解压后在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」选该文件夹；" -ForegroundColor DarkGray
Write-Host "或直接把 zip 上传到 Chrome Web Store 开发者后台。" -ForegroundColor DarkGray
