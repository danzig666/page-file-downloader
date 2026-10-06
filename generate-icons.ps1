param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "icons")
)

Add-Type -AssemblyName System.Drawing
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $bitmap.SetResolution(96, 96)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $margin = [Math]::Max(1, [Math]::Round($size * 0.06))
  $radius = [Math]::Max(3, [Math]::Round($size * 0.22))
  $rect = [System.Drawing.RectangleF]::new($margin, $margin, $size - (2 * $margin), $size - (2 * $margin))
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = 2 * $radius
  $path.AddArc($rect.Left, $rect.Top, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Top, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.Left, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  $background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(49, 87, 213))
  $graphics.FillPath($background, $path)
  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)

  $shaftWidth = [Math]::Max(2, [Math]::Round($size * 0.16))
  $shaftX = ($size - $shaftWidth) / 2
  $graphics.FillRectangle($white, $shaftX, $size * 0.23, $shaftWidth, $size * 0.36)
  $arrow = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($size * 0.24, $size * 0.50),
    [System.Drawing.PointF]::new($size * 0.50, $size * 0.76),
    [System.Drawing.PointF]::new($size * 0.76, $size * 0.50)
  )
  $graphics.FillPolygon($white, $arrow)
  $graphics.FillRectangle($white, $size * 0.23, $size * 0.80, $size * 0.54, [Math]::Max(1, $size * 0.07))

  $target = Join-Path $OutputDirectory "icon$size.png"
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $white.Dispose()
  $background.Dispose()
  $path.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Host "Generated Page File Downloader icons in $OutputDirectory"
