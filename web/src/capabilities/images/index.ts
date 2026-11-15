import type { CapabilityId } from '@/product/capability';

export {
  IMAGE_BUILD_UPDATED_WIRE,
  imagesApi,
  ImagesPlugin,
  type ImageBuildDescriptor,
  type ImageBuildPage,
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
  ImagesPanel,
  ImagesLibraryPanel,
  ImagesBuildsPanel,
} from './components/ImagesWorkspace';
export {
  IMAGE_PAGE_SIZE,
  cacheStateLabel,
  cacheStatusByDigest,
  imageAliases,
  imageBuildProgressLabel,
  imageBuildStageLabel,
  imageBuildStatusLabel,
  imageServerStatusLabel,
  isTerminalBuild,
  shortDigest,
  sourceLabel,
} from './model';
export { useImageBuilds, type ImageBuildsState } from './hooks/useImageBuilds';
export { useImagesPage } from './hooks/useImagesPage';
