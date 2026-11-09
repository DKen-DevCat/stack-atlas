<?php
// 旧システムの月次集計（Go に移す前の API）。GET /stats?month=YYYY-MM
// /stats をこのファイルに向けるのは Web サーバーの設定（このリポジトリの外）。
declare(strict_types=1);

$month = $_GET['month'] ?? date('Y-m');
$pdo = new PDO((string)getenv('LEGACY_DSN'));

$sum = $pdo->prepare("SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE to_char(occurred_at, 'YYYY-MM') = ?");
$sum->execute([$month]);
$total = (int)$sum->fetchColumn();

$top = $pdo->prepare("SELECT merchant FROM transactions WHERE to_char(occurred_at, 'YYYY-MM') = ? GROUP BY merchant ORDER BY SUM(amount) DESC LIMIT 1");
$top->execute([$month]);
$topMerchant = (string)($top->fetchColumn() ?: '');

header('Content-Type: application/json');
echo json_encode(['month' => $month, 'total' => $total, 'topMerchant' => $topMerchant]);
