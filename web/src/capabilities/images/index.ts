import type { CapabilityId } from '@/product/capability';

export {
  imagesApi,
  ImagesPlugin,
  type ImageAccessGrant,
  type ImageDescriptor,
  type ImagePage,
  type ImageSource,
} from './ImagesPlugin';

/** The capability's registered identity. */
export const IMAGES_CAPABILITY_ID: CapabilityId = 'images';
export const IMAGES_TITLE = 'Images';
export const IMAGES_SHORT_TITLE = 'Images';

export {
  ImagesWorkspace,
  ImagesWebLayout,
  ImagesAppLayout,
  ImagesDetail,
} from './components/ImagesWorkspace';
export {
  IMAGE_PAGE_SIZE,
  cacheStateLabel,
  cacheStatusByDigest,
  imageAliases,
  imageServerStatusLabel,
  shortDigest,
  sourceLabel,
} from './model';
export { useImagesPage } from './hooks/useImagesPage';
