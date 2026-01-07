export type Artwork = {
  id: string;
  source: "met" | "artic" | "svgrepo";
  sourceId: string;
  title: string;
  description?: string;
  artist?: string;
  date?: string;
  isPublicDomain: boolean;
  license: string;
  licenseUrl?: string;
  rights?: string;
  sourceUrl: string;
  collection?: {
    name: string;
    url: string;
  };
  author?: {
    name: string;
    url: string;
  };
  tags?: string[];
  image: {
    originalUrl: string;
    localOriginalPath?: string;
    localResizedPaths?: Record<string, string>;
  };
  search: {
    query: string;
    downloadedAt: string;
  };
};
