-- 「付け替える」を「手動で割り当てる」に改名（ほかの枠に出勤している人にも割り当てられる。docs/005_order.md 3章）。キーは変えない
update permissions set label = '手動で割り当てる' where key = 'order.reassign';
