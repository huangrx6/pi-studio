import type catalog from '../../../assets/settings/profile-icons.json';

export type ProfileIcon = { shape: keyof typeof catalog.shapes; ink?: keyof typeof catalog.inks };
export type ProfileIconGroup = keyof typeof catalog.shapes.baseline;
