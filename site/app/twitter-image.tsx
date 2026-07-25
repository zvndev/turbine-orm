import { OG_CARD_ALT, OG_CARD_CONTENT_TYPE, OG_CARD_SIZE, renderOgCard } from '../components/OgCard';

export const runtime = 'edge';

export const alt = OG_CARD_ALT;
export const size = OG_CARD_SIZE;
export const contentType = OG_CARD_CONTENT_TYPE;

export default function TwitterImage() {
  return renderOgCard();
}
