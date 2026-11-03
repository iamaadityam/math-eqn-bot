/* Rating-snake lobby builder. Pure aside from random bot selection.
   Every lobby is exactly `size` players and empty seats become bots close to
   the lobby average. 60 humans -> 6 full lobbies. 3 humans -> 3 + 7 bots. */
"use strict";

function makeLobbies(entries, ladder, size = 10) {
  const list = Array.from(entries || []);
  if (!list.length) return [];
  const lobbyCount = Math.max(1, Math.ceil(list.length / size));
  const sorted = list.slice().sort((a, b) =>
    ((b.profile && b.profile.rating) || 1000) - ((a.profile && a.profile.rating) || 1000)
  );
  const groups = Array.from({ length: lobbyCount }, () => []);

  // Serpentine draft keeps every lobby's rating average close.
  sorted.forEach((entry, index) => {
    const round = Math.floor(index / lobbyCount);
    const position = index % lobbyCount;
    const lobbyIndex = round % 2 === 0 ? position : lobbyCount - 1 - position;
    groups[lobbyIndex].push(entry);
  });

  const usedBots = new Set();
  for (const group of groups) {
    const average = group.reduce((sum, entry) =>
      sum + ((entry.profile && entry.profile.rating) || 1000), 0) / Math.max(1, group.length);
    while (group.length < size) {
      const bot = ladder.pickBot(average, usedBots);
      usedBots.add(bot.id);
      group.push({ token: null, profile: bot, isBot: true });
    }
  }
  return groups;
}

module.exports = { makeLobbies };
