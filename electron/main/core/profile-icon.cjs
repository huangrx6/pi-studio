const catalog = require('../../../assets/settings/profile-icons.json');

function normalizeProfileIcon(icon) {
  if (!icon || typeof icon.shape !== 'string' || !Object.hasOwn(catalog.shapes, icon.shape)) return null;
  const { shape, ink } = icon;
  if (ink === undefined) return { shape };
  if (typeof ink !== 'string' || !Object.hasOwn(catalog.inks, ink)) return null;
  return { shape, ink };
}

module.exports = { normalizeProfileIcon };
