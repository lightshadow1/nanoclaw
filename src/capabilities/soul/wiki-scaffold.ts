import fs from 'fs';
import path from 'path';

const STARTERS: Record<string, string> = {
  '_index.md':
    '# Wiki Index\n\nNo pages curated yet. The curator will populate this as observations accumulate.\n',
  'people.md':
    '# People\n\nWhat the soul knows about people it interacts with in this group.\n',
  'preferences.md':
    "# Preferences\n\nCommunication style, pet peeves, and other preferences observed in this group.\n",
  'learnings.md':
    '# Learnings\n\nThings the soul has learned in this group.\n',
};

export function ensureWikiForGroup(groupsDir: string, folder: string): void {
  const wikiDir = path.join(groupsDir, folder, 'soul', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });

  for (const [name, content] of Object.entries(STARTERS)) {
    const filePath = path.join(wikiDir, name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
}
