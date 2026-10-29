export type Language = 'ko' | 'en';
export interface MenuItem {
  label: string;
  href?: string;
  children: MenuItem[];
}
export interface ArchivePage {
  id: string;
  title: string;
  lang: Language;
  alternate: Partial<Record<Language, string>>;
  category: string;
  source: string;
  contentFile: string;
  image?: string;
  excerpt: string;
  unavailable: boolean;
  canonical: boolean;
}
export interface ArchiveDocument {
  file: string;
  href: string;
  bytes: number;
  label: string;
}
export interface Catalog {
  pages: ArchivePage[];
  menus: Record<Language, MenuItem[]>;
  homeIds: Record<Language, string>;
  documents: ArchiveDocument[];
}
