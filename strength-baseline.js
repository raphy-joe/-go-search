'use strict';

function parseGroupL(groupName) {
  if (!groupName) return null;
  const g = groupName.trim();
  if (/启蒙|吃子|入门|幼儿|棋趣/.test(g)) return null;
  if (/定段/.test(g)) return 25.3;

  const rangeM = g.match(/(\d+)\s*[~\-－—至到]\s*(\d+)\s*级/);
  if (rangeM) {
    const a = 26 - parseInt(rangeM[1], 10);
    const b = 26 - parseInt(rangeM[2], 10);
    return (a + b) / 2;
  }

  const lvM = g.match(/(\d+)\s*级/);
  if (lvM) {
    const lv = parseInt(lvM[1], 10);
    if (lv >= 1 && lv <= 25) return 26 - lv;
  }

  const danM = g.match(/(\d+)\s*段/);
  if (danM) {
    const d = parseInt(danM[1], 10);
    if (d >= 1 && d <= 8) return 25 + d;
  }

  if (/低段/.test(g)) return 27.5;
  if (/高段/.test(g)) return 30;
  if (isOpenGroup(g)) return 30.15;
  return null;
}

function isOpenGroup(groupName) {
  return /公开/.test(groupName || '');
}

function parseAgeGradeL(groupName, eventTitle, organizer) {
  if (!groupName) return null;
  const g = groupName.trim();
  const isAge = /[一二三四五六]年级|低年级|高年级|小学.*组|儿童.*组|少儿.*组|初中|中学生?组|U\d+|\d+\s*岁|[甲乙丙丁ABCDＡＢＣＤ]组/.test(g);
  if (!isAge) return null;
  if (/启蒙|吃子|入门/.test(g)) return null;

  const text = `${eventTitle || ''} ${organizer || ''}`;
  let tierBase;
  if (/全国|国际/.test(text)) tierBase = 29.85;
  else if (/省/.test(text)) tierBase = 29.35;
  else if (/市/.test(text)) tierBase = 28.85;
  else if (/区|县/.test(text)) tierBase = 27.5;
  else if (/学校|班级|校内/.test(text)) tierBase = 24.0;
  else tierBase = 27.5;

  let adj = 0;
  const gradeMap = { '一': 0, '二': 0.25, '三': 0.5, '四': 0.75, '五': 1.0, '六': 1.25 };
  for (const [ch, a] of Object.entries(gradeMap)) {
    if (g.includes(`${ch}年级`)) { adj = a; break; }
  }
  if (/低年级/.test(g)) adj = 0.2;
  if (/高年级/.test(g)) adj = 0.9;
  if (/初中|中学生/.test(g)) adj = 1.35;
  if (/甲组/.test(g) && adj === 0) adj = 0.9;
  if (/乙组/.test(g) && adj === 0) adj = 0.55;
  if (/丙组/.test(g) && adj === 0) adj = 0.2;
  if (/丁组/.test(g) && adj === 0) adj = 0;
  if (/[AＡ]组/.test(g) && adj === 0) adj = 0.85;
  if (/[BＢ]组/.test(g) && adj === 0) adj = 0.45;
  if (/[CＣ]组/.test(g) && adj === 0) adj = 0.15;
  if (/[DＤ]组/.test(g) && adj === 0) adj = 0;

  const uM = g.match(/U(\d+)/i);
  const aM = g.match(/(\d+)\s*岁/);
  const age = uM ? parseInt(uM[1], 10) : aM ? parseInt(aM[1], 10) : null;
  if (age !== null) {
    adj = age <= 7 ? 0 : age <= 9 ? 0.25 : age <= 11 ? 0.6 : age <= 13 ? 1.0 : 1.35;
  }

  return tierBase + adj;
}

function winRateAdj(win, lose, draw) {
  const total = win + lose + draw;
  if (total === 0) return 0;
  return 1.5 * ((win + 0.5 * draw) / total - 0.5);
}

function rowBase(row) {
  const skillL = parseGroupL(row.group_name);
  const ageL = skillL === null ? parseAgeGradeL(row.group_name, row.title, row.cname) : null;
  const LGroup = skillL ?? ageL;
  if (LGroup === null) return null;

  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const total = win + lose + draw;
  if (total === 0) return null;

  const isAgeGroup = skillL === null;
  const isOpen = !isAgeGroup && isOpenGroup(row.group_name);
  let wrAdj = winRateAdj(win, lose, draw);
  if (isOpen && wrAdj > 0) wrAdj *= 0.75;
  if (isOpen && wrAdj < 0) wrAdj *= 0.6;

  const base = LGroup + (isAgeGroup ? 0 : 0.35) + wrAdj;
  return {
    base: isOpen ? Math.max(base, 29.2) : base,
    groupL: LGroup,
    wrAdj,
    isAgeGroup,
    isOpen,
  };
}


module.exports = { parseGroupL, rowBase };
