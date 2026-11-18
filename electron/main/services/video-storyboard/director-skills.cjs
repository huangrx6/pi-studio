const fs = require('node:fs');
const path = require('node:path');
const { discoverSkills, parseFrontmatter } = require('../../capabilities/skills/index.cjs');

const directorFile = path.join(__dirname, '../../../../assets/storyboard/skills/storyboard-director/SKILL.md');

function loadDirectorSkills(workspace, aspect, discover = discoverSkills) {
  const director = parseFrontmatter(fs.readFileSync(directorFile, 'utf8'));
  const parts = [director.body.trim()];
  const names = [director.fields.name];
  const layout = aspect === '9:16' ? 'portrait-subtitle-layout' : 'landscape-subtitle-layout';
  const wanted = new Set(['remotion-markup']);
  if (aspect !== '1:1') wanted.add(layout);
  // Use the same precedence and project-trust decisions as the Studio skill picker.
  const installed = workspace ? discover(workspace).skills : [];
  for (const skill of installed) {
    if (!wanted.has(skill.name) || !skill.available || skill.disableModelInvocation) continue;
    let body;
    try { body = parseFrontmatter(fs.readFileSync(skill.path, 'utf8')).body.trim(); }
    catch { continue; } // May have been moved after discovery.
    if (!body) continue;
    parts.push(`参考制作技能 ${skill.name}。选择可由本工作台合成参数表达的剪辑和排版建议。\n${body.slice(0, 8000)}`);
    names.push(skill.name);
  }
  return { prompt: parts.join('\n\n'), names };
}

module.exports = { loadDirectorSkills };
