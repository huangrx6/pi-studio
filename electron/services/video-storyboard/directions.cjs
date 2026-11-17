// Editorial starting points for the offline planning flow. Each requirement belongs to a cut,
// so a text-led explainer and a vows-led wedding film can ask for different material.
const picture = { label: '开场画面', kinds: ['image', 'video'], count: 1 };
const voice = { label: '誓词原声', kinds: ['audio', 'video'], count: 1, select: true };
const demonstration = { label: '演示片段', kinds: ['video'], count: 1 };
const comparison = { label: '两份对比画面', kinds: ['image', 'video'], count: 2, select: true };

const pairs = {
  wedding: [
    ['photo', '从一张合影开始', ['先让合影停留', '讲一个两人之间的细节', '回到合影收尾'], picture],
    ['vows', '让誓词串起这一天', ['先听见一句誓词', '用当天的片段回应它', '让原声自然收束'], voice],
  ],
  education: [
    ['question', '从观众的问题讲起', ['抛出一个日常问题', '用示意或文字解释原理', '用一句话回扣问题']],
    ['experiment', '先看一次实验', ['展示现象', '慢放关键变化并解释', '请观众预测下一次结果'], demonstration],
  ],
  product: [
    ['result', '先展示使用结果', ['把结果放在第一镜', '拆开关键操作', '回到真实使用场景'], picture],
    ['compare', '对照两种操作体验', ['交代同一个任务', '并列两种操作路径', '指出体验变化'], comparison],
  ],
  free: [
    ['moment', '从一个细节展开', ['停在一个细节', '拉开交代场景', '回到最初的细节']],
    ['sequence', '顺着事件的时间线讲', ['交代起点', '保留转折', '停在事情发生后的片刻']],
  ],
};

function inferGenre(genre, text) {
  if (genre !== 'free') return genre;
  if (/婚礼|婚宴|新婚|誓词|新人/.test(text)) return 'wedding';
  if (/知识|原理|实验|科普|讲解|为什么/.test(text)) return 'education';
  if (/产品|界面|操作|功能|更新演示/.test(text)) return 'product';
  return 'free';
}

function directionOptions(genre, focus, exploring) {
  let options = pairs[genre];
  if (exploring) {
    const quiet = /静|慢|情绪|温柔|声音|细节/.test(focus);
    const alternate = quiet
      ? ['quiet', '给一个细节留足时间', ['从局部或一段声音进入', '放慢节奏揭示它的意义', '停顿后再收尾']]
      : ['reverse', '从结尾倒着讲', ['先看到结局', '回到改变结果的瞬间', '让前后画面呼应']];
    options = [alternate, options[quiet ? 0 : 1]];
  }
  return options.map(([id, title, beats, need]) => ({ id, title, beats, ...(need && { need }) }));
}

module.exports = { inferGenre, directionOptions };
