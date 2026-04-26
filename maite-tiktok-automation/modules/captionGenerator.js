const CAPTION_TEMPLATES = [
  "Just being myself 💫 #viral #trend #dance #tiktokviral #fyp",
  "this one stayed in my head 💫 #fyp #viral #mood #dancetrend",
  "This mood 💅 #fyp #viral #mood #trend #aesthetic",
  "Just me 😄 #dance #dancechallenge #dancinhasdotiktok #viral #trend",
  "Feeling this energy today ✨ #fyp #viral #mood #aesthetic #trend",
  "Just a little vibe today ✨ #fyp #viral #vibes #trend #aesthetic",
  "Sunlight + good energy ✨💙 #fyp #blogueirinha #viral #outfit #trend",
  "Living for this ✨ #dance #viral #fyp #trend #aesthetic",
  "POV: it's giving everything 💅 #fyp #viral #dance #trend",
  "Main character energy 🌟 #fyp #viral #dance #aesthetic #trend",
  "Can't stop won't stop 💃 #dance #viral #fyp #trend #dancechallenge",
  "Obsessed with this vibe 🌸 #fyp #viral #mood #aesthetic #dance",
  "She's that girl ✨ #fyp #viral #trend #aesthetic #dance",
  "Not me vibing alone in my room 😂✨ #fyp #viral #dance #trend",
  "This just hits different 💫 #fyp #viral #mood #dance #trend",
  "Soft girl era 🌸 #fyp #viral #aesthetic #dance #trend",
  "Girlie pop moment 💕 #fyp #viral #trend #dance #aesthetic",
  "Low key obsessed 😍 #fyp #viral #mood #trend #dance",
  "Catching feelings for this trend 💙 #fyp #viral #dance #trend",
  "Real ones know 💫 #fyp #viral #dance #trend #aesthetic",
  "Ok but why does this hit so hard ✨ #fyp #viral #dance #mood",
];

function getDailyCaptions(dateStr) {
  // Usar o dia do ano como seed para selecionar 3 legendas únicas que não se repetem na mesma semana
  const date = new Date(dateStr);
  const seed = date.getDay() + Math.floor(date / (7 * 24 * 60 * 60 * 1000));
  const indices = [
    seed % CAPTION_TEMPLATES.length,
    (seed + 7) % CAPTION_TEMPLATES.length,
    (seed + 14) % CAPTION_TEMPLATES.length,
  ];
  return indices.map(i => CAPTION_TEMPLATES[i]);
}

module.exports = { getDailyCaptions };
