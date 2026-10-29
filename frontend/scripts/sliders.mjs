export function sourceSliders(html) {
  const result = [];
  for (const match of html.matchAll(/SR7\.JSON\[['"]([^'"]+)['"]\]\s*=/g)) {
    const start = html.indexOf('{', match.index + match[0].length);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < html.length; index++) {
      const character = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) { end = index + 1; break; }
    }
    if (start < 0 || end < 0) throw new Error(`Invalid source slider JSON: ${match[1]}`);
    const data = JSON.parse(html.slice(start, end));
    const sharedLayers = Object.values(data.slides).find(slide => Object.keys(slide.layers).length)?.layers || {};
    const motions = Object.entries(data.slides).filter(([, slide]) => !slide.slide.global).map(([key, slide]) => {
      const layers = { ...sharedLayers, ...slide.layers };
      const background = Object.values(layers).find(layer => layer.subtype === 'slidebg')?.tl?.in?.bg?.all?.find(frame => frame.d);
      const caption = Object.values(layers).find(layer => layer.type === 'text');
      const entry = caption?.tl?.in?.content?.all;
      const exit = caption?.tl?.out?.content?.all?.[0];
      if (!background || !entry?.[1] || !exit) throw new Error(`Missing source hero animation: ${match[1]} slide ${key}`);
      return {
        key,
        backgroundDuration: Number(background.d),
        backgroundEasing: background.e,
        textDelay: Number(entry[1].t),
        textDuration: Number(entry[1].d),
        textEasing: entry[1].e,
        textFromY: parseFloat(entry[0].y[0]),
        textExitDuration: Number(exit.d),
        textExitEasing: exit.e,
      };
    });
    result.push({
      id: match[1],
      arrows: Boolean(data.settings.nav?.arrows?.set),
      arrowClass: data.settings.nav?.arrows?.key || '',
      arrowCss: data.settings.nav?.arrows?.css || '',
      delay: Number(data.settings.default?.len) || 9000,
      pauseOnHover: Boolean(data.settings.slideshow?.sOH),
      motions,
    });
  }
  return result;
}
