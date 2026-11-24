# Turn-complete card: a compact always-on-top card in the lower right corner.
# Started by the plugin host with the placeholder tokens already replaced.
#
# The card is a fixed size: the body gets one line when the whole「标题 · 用时」
# fits and two lines otherwise, and the height always keeps room for two lines so
# the card never jumps around between reminders. The whole face is rendered once
# into a bitmap and only blitted on paint: text drawn straight into the first
# paint of a window shown without activation can be dropped silently.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Native
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

[Native]::SetProcessDPIAware() | Out-Null

$skipForeground = '@@SKIP_IF_FOREGROUND@@' -eq '1'
if ($skipForeground) {
    try {
        $foreground = [Native]::GetForegroundWindow()
        $foregroundPid = [uint32]0
        [void][Native]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
        $owner = Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -like 'DeepSeek*') { exit 0 }
    } catch { }
}

$heading = '@@HEADING@@'
$titleText = '@@TITLE@@'
$durationText = '@@DURATION@@'
$separator = ' · '
$hint = '点击卡片回到对话'

# Layout constants. The text column starts after the badge; positions inside the
# card are fixed so every reminder has exactly the same footprint.
$padLeft = 24
$padRight = 26
$padTop = 20
$padBottom = 18
$columnLeft = 90
$headingGap = 18
$hintGap = 10
$width = 640
$radius = 16
$badgeSize = 52

$sheet = [System.Drawing.Color]::FromArgb(24, 26, 32)
$line = [System.Drawing.Color]::FromArgb(54, 60, 76)
$accent = [System.Drawing.Color]::FromArgb(126, 162, 255)
$accentSoft = [System.Drawing.Color]::FromArgb(34, 45, 74)
$headingInk = [System.Drawing.Color]::FromArgb(244, 246, 251)
$detailInk = [System.Drawing.Color]::FromArgb(152, 160, 178)
$hintInk = [System.Drawing.Color]::FromArgb(112, 120, 138)

$headingFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$detailFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$hintFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)

function Measure-Text([string]$text, $font, [int]$width) {
    $probe = New-Object System.Drawing.Bitmap 1, 1
    $probeGraphics = [System.Drawing.Graphics]::FromImage($probe)
    $probeGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    if ($width -gt 0) {
        $size = $probeGraphics.MeasureString($text, $font, $width)
    } else {
        $size = $probeGraphics.MeasureString($text, $font)
    }
    $probeGraphics.Dispose()
    $probe.Dispose()
    return $size
}

# Longest leading slice of $text that still fits $width, so the part that has to
# be dropped can be replaced by an ellipsis instead of clipping the whole tail.
function Fit-Prefix([string]$text, $font, [double]$width) {
    $low = 0
    $high = $text.Length
    while ($low -lt $high) {
        $middle = [int][Math]::Ceiling(($low + $high) / 2)
        $measured = (Measure-Text $text.Substring(0, $middle) $font 0).Width
        if ($measured -le $width) {
            $low = $middle
        } else {
            $high = $middle - 1
        }
    }
    return $low
}

$headingSize = Measure-Text $heading $headingFont 0
$hintSize = Measure-Text $hint $hintFont 0
$titleSize = Measure-Text $titleText $detailFont 0
$separatorSize = Measure-Text $separator $detailFont 0
$durationSize = Measure-Text $durationText $detailFont 0
$lineHeight = [Math]::Ceiling((Measure-Text '任务完成' $detailFont 0).Height)

# The duration must stay whole, so it is laid out as its own chunk and only the
# session title is allowed to be shortened.
$inlineWidth = $titleSize.Width + $separatorSize.Width + $durationSize.Width
$textWidth = $width - $columnLeft - $padRight

# The body uses one line when everything fits and two lines otherwise; the card
# height always keeps room for two, so consecutive reminders line up exactly.
$detailLines = if ($inlineWidth -le $textWidth) { 1 } else { 2 }
$detailHeight = [Math]::Ceiling($lineHeight * 2)

$headingTop = $padTop
$detailTop = $headingTop + [Math]::Ceiling($headingSize.Height) + $headingGap
$hintTop = $detailTop + $detailHeight + $hintGap
$height = [int]($hintTop + [Math]::Ceiling($hintSize.Height) + $padBottom)

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = $screen.Right - $width - 30
$y = $screen.Bottom - $height - 16

function New-RoundedPath([int]$left, [int]$top, [int]$w, [int]$h, [int]$corner) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $corner * 2
    $path.AddArc($left, $top, $diameter, $diameter, 180, 90)
    $path.AddArc($left + $w - $diameter, $top, $diameter, $diameter, 270, 90)
    $path.AddArc($left + $w - $diameter, $top + $h - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($left, $top + $h - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

$face = New-Object System.Drawing.Bitmap $width, $height
$ink = [System.Drawing.Graphics]::FromImage($face)
$ink.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$ink.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$ink.Clear($sheet)

$shape = New-RoundedPath 0 0 $width $height $radius
$ink.DrawPath((New-Object System.Drawing.Pen($line, 1)), $shape)

# Round badge with a check mark: emoji glyphs render unreliably here.
$badgeTop = [int]($headingTop + (($hintTop + $hintSize.Height - $headingTop) - $badgeSize) / 2)
$ink.FillEllipse((New-Object System.Drawing.SolidBrush($accentSoft)), $padLeft, $badgeTop, $badgeSize, $badgeSize)
$checkPen = New-Object System.Drawing.Pen($accent, 3.2)
$checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$checkX = $padLeft + 15
$checkY = $badgeTop + 26
$ink.DrawLines($checkPen, @(
    (New-Object System.Drawing.PointF $checkX, $checkY),
    (New-Object System.Drawing.PointF ($checkX + 10), ($checkY + 10)),
    (New-Object System.Drawing.PointF ($checkX + 23), ($checkY - 9))
))

$headingBrush = New-Object System.Drawing.SolidBrush($headingInk)
$detailBrush = New-Object System.Drawing.SolidBrush($detailInk)
$hintBrush = New-Object System.Drawing.SolidBrush($hintInk)

$ink.DrawString($heading, $headingFont, $headingBrush, $columnLeft, $headingTop)

if ($detailLines -eq 1) {
    # One line of text in a two-line slot: centre it so the card stays balanced.
    $singleTop = $detailTop + [Math]::Ceiling(($detailHeight - $lineHeight) / 2)
    $ink.DrawString($titleText + $separator + $durationText, $detailFont, $detailBrush, $columnLeft, $singleTop)
} else {
    # Line one: as much of the title as fits. Line two: whatever is left of the
    # title, shortened with an ellipsis to make room for the whole duration.
    $firstCut = Fit-Prefix $titleText $detailFont $textWidth
    $firstLine = $titleText.Substring(0, $firstCut).TrimEnd()
    $rest = $titleText.Substring($firstCut).TrimStart()
    $durationWithSeparator = $separator + $durationText
    $durationWidth = $separatorSize.Width + $durationSize.Width
    $roomForRest = $textWidth - $durationWidth

    $secondLine = ''
    if ($rest.Length -gt 0) {
        $secondCut = Fit-Prefix $rest $detailFont $roomForRest
        if ($secondCut -ge $rest.Length) {
            $secondLine = $rest
        } else {
            $secondLine = $rest.Substring(0, $secondCut).TrimEnd() + '…'
        }
    }

    $ink.DrawString($firstLine, $detailFont, $detailBrush, $columnLeft, $detailTop)
    if ($secondLine.Length -gt 0) {
        $ink.DrawString($secondLine, $detailFont, $detailBrush, $columnLeft, ($detailTop + $lineHeight))
    }
    $durationLeft = $columnLeft + $textWidth - $durationWidth
    $durationInk = $detailInk
    $ink.DrawString($durationWithSeparator, $detailFont, (New-Object System.Drawing.SolidBrush($durationInk)), $durationLeft, ($detailTop + $lineHeight))
}

$ink.DrawString($hint, $hintFont, $hintBrush, $columnLeft, $hintTop)

$crossInk = [System.Drawing.Color]::FromArgb(122, 130, 148)
$crossPen = New-Object System.Drawing.Pen($crossInk, 1.6)
$crossPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$crossPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$ink.DrawLine($crossPen, $width - 40, 18, $width - 28, 30)
$ink.DrawLine($crossPen, $width - 28, 18, $width - 40, 30)
$ink.Dispose()

$card = New-Object System.Windows.Forms.Form
$card.FormBorderStyle = 'None'
$card.StartPosition = 'Manual'
$card.TopMost = $true
$card.ShowInTaskbar = $false
$card.BackColor = $sheet
$card.SetBounds($x, $y, $width, $height)
$card.Region = [System.Drawing.Region]::new((New-RoundedPath 0 0 $width $height $radius))
$card.Add_Paint({
    param($sender, $eventArgs)
    $eventArgs.Graphics.DrawImageUnscaled($script:face, 0, 0)
})

$activate = {
    try {
        $target = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -like 'DeepSeek*' -and $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
        if ($target) {
            [void][Native]::ShowWindow($target.MainWindowHandle, 9)
            [void][Native]::SetForegroundWindow($target.MainWindowHandle)
        }
    } catch { }
    [System.Windows.Forms.Application]::Exit()
}

$card.Add_Click($activate)

$closeArea = New-Object System.Windows.Forms.Panel
$closeArea.BackColor = $sheet
$closeArea.SetBounds($width - 52, 10, 40, 32)
$closeArea.Cursor = [System.Windows.Forms.Cursors]::Hand
$closeArea.Add_Click({
    param($sender, $eventArgs)
    [System.Windows.Forms.Application]::Exit()
})
$closeArea.Add_Paint({
    param($sender, $eventArgs)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(158, 166, 182), 1.6)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $eventArgs.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $eventArgs.Graphics.DrawLine($pen, 14, 10, 26, 22)
    $eventArgs.Graphics.DrawLine($pen, 26, 10, 14, 22)
    $pen.Dispose()
})
$card.Controls.Add($closeArea)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = @@AUTO_CLOSE_MS@@
$timer.Add_Tick({ $timer.Stop(); [System.Windows.Forms.Application]::Exit() })
$card.Add_Shown({ $timer.Start() })
$card.Add_MouseEnter({ $timer.Stop() })
$card.Add_MouseLeave({ $timer.Start() })

try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }

# A process started without a console (which is how the Harness launches this
# script) inherits a hidden first-show state, so showing the card normally can
# leave it invisible. Show it explicitly, unactivated, and pin it on top.
$card.Show()
[void][Native]::ShowWindow($card.Handle, 4)
[void][Native]::SetWindowPos($card.Handle, [IntPtr](-1), $x, $y, $width, $height, 0x0040)

[System.Windows.Forms.Application]::Run()
