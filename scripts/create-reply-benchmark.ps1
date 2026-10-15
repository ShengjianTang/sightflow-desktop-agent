param([Parameter(Mandatory=$true)][string]$CasesPath,[Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$cases=Get-Content -LiteralPath $CasesPath -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
foreach($case in $cases){
 $bmp=New-Object System.Drawing.Bitmap 900,700
 $g=[System.Drawing.Graphics]::FromImage($bmp)
 $dark=[System.Drawing.Color]::FromArgb(30,30,30)
 $g.Clear($dark)
 $font=New-Object System.Drawing.Font 'Microsoft YaHei',18
 $small=New-Object System.Drawing.Font 'Microsoft YaHei',12
 $brush=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(55,55,55))
 $green=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(45,200,135))
 $g.DrawString('合成测试群 (3)',$font,[System.Drawing.Brushes]::White,20,15)
 $g.DrawLine([System.Drawing.Pens]::DimGray,0,65,900,65)
 if($case.page -eq 'empty'){$g.Clear($dark);$g.DrawEllipse([System.Drawing.Pens]::Gray,390,280,75,55);$g.DrawEllipse([System.Drawing.Pens]::Gray,425,310,75,55)}
 elseif($case.page -eq 'non_chat'){$g.DrawString('公众号文章：这是阅读页面',$font,[System.Drawing.Brushes]::White,50,140);$g.DrawString('阅读文章，不是聊天会话，没有输入框。',$font,[System.Drawing.Brushes]::White,50,200)}
 else {
  $g.DrawLine([System.Drawing.Pens]::DimGray,0,560,900,560)
  $g.DrawString('发送',$small,[System.Drawing.Brushes]::Gray,820,665)
  if($case.draft){$g.DrawString('我正在输入草稿，请勿发送',$font,[System.Drawing.Brushes]::White,25,600)}
  $i=0
  foreach($message in $case.messages){
   $y=100+($i*115);$i++
   $isOwn=$message.sender -eq 'self'
   $avatarX=if($isOwn){850}else{16};$bubbleX=if($isOwn){340}else{72}
   if(!$case.hideAvatar){$g.FillRectangle([System.Drawing.Brushes]::SteelBlue,$avatarX,$y,36,36);$g.DrawString($(if($isOwn){'我'}else{'A'}),$small,[System.Drawing.Brushes]::White,($avatarX+4),($y+5))}
   if($message.kind -eq 'image'){
    $g.FillRectangle([System.Drawing.Brushes]::White,$bubbleX,$y,90,90)
    $color=[System.Drawing.Color]::FromName([string]$message.color);$cbrush=New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($cbrush,($bubbleX+10),($y+10),68,68);$cbrush.Dispose()
   }elseif($message.kind -eq 'emoji'){
    $g.FillEllipse([System.Drawing.Brushes]::Gold,$bubbleX,$y,80,80)
    $g.FillEllipse([System.Drawing.Brushes]::Black,($bubbleX+18),($y+22),8,10);$g.FillEllipse([System.Drawing.Brushes]::Black,($bubbleX+54),($y+22),8,10)
    $pen=New-Object System.Drawing.Pen ([System.Drawing.Color]::Black),4
    $g.DrawArc($pen,($bubbleX+20),($y+34),40,27,0,180);$pen.Dispose()
   }else{
    $g.FillRectangle($(if($isOwn){$green}else{$brush}),$bubbleX,$y,490,55)
    $g.DrawString([string]$message.text,$font,$(if($isOwn){[System.Drawing.Brushes]::Black}else{[System.Drawing.Brushes]::White}),($bubbleX+8),($y+8))
   }
  }
 }
 $bmp.Save((Join-Path $OutputDir ($case.id+'.png')),[System.Drawing.Imaging.ImageFormat]::Png)
 $g.Dispose();$bmp.Dispose();$font.Dispose();$small.Dispose();$brush.Dispose();$green.Dispose()
}
Write-Output ('GENERATED='+$cases.Count)
