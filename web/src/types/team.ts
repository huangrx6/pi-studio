export type TeamBot = {
  id: string;
  name: string;
};

export type TeamRoom = {
  id: string;
  name: string;
  botIds: string[];
};

export type TeamProjectState = {
  bots: TeamBot[];
  rooms: TeamRoom[];
};
