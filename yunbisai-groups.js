'use strict';

const { isGoEvent, isGoGroup } = require('./sport-filter');
const API = 'https://data-center.yunbisai.com/api/lswl-groups/event/';
const HTML = 'https://www.yunbisai.com/tpl/eventFeatures/eventDetail-';

function decode(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function fetchEventGroups(eventId, { fetchText, eventTitle = '' }) {
  if (!/^\d{1,15}$/.test(String(eventId))) throw new Error('invalid event identity');
  const options = { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 };
  try {
    const json = JSON.parse(await fetchText(`${API}${eventId}`, options, 1));
    if (Number(json.error) !== 0 || !Array.isArray(json.data)) throw new Error('invalid group response');
    const seen = new Set();
    return json.data.filter(g => String(g.eventtype) === '2' && isGoGroup('', g.groupname))
      .map(g => {
        const groupid = String(g.groupid || '');
        if (!/^\d{1,15}$/.test(groupid) || (g.eventid != null && String(g.eventid) !== String(eventId))) {
          throw new Error('invalid group identity');
        }
        return { groupid, groupname: g.groupname || '', pnumber: parseInt(g.pnumber) || 0,
          team: String(g.team ?? '0'), groupstate: String(g.groupstate ?? ''),
          bt: g.begintime || '', et: g.endtime || '' };
      }).filter(g => {
        if (seen.has(g.groupid)) return false;
        seen.add(g.groupid);
        return true;
      });
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'INDEX_STOPPED') throw error;
    const html = await fetchText(`${HTML}${eventId}.html`, options, 1);
    const title = eventTitle || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]);
    const groups = [], seen = new Set();
    for (const [anchor] of html.matchAll(/<a\b[^>]*data-groupid=["']?\d+["']?[^>]*>/gi)) {
      const attrs = {};
      for (const [, key, value] of anchor.matchAll(/data-([a-z0-9_-]+)=["']([^"']*)["']/gi)) {
        attrs[key.replace(/-/g, '')] = decode(value);
      }
      if (!attrs.groupid || seen.has(attrs.groupid)) continue;
      seen.add(attrs.groupid);
      if (isGoEvent({ title }) && isGoGroup(title, attrs.groupname)) groups.push(attrs);
    }
    if (!groups.length) throw new Error('云比赛赛事组别暂时读取失败，请稍后重试');
    return groups;
  }
}

module.exports = { fetchEventGroups };
