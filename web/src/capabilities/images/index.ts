import type { CapabilityId } from '@/product/capability';

export {
  IMAGE_BUILD_UPDATED_WIRE,
  ImageTagMutationError,
  imagesApi,
  ImagesPlugin,
  type ImageBuildDescriptor,
  type ImageBuildPage,
  type ImageDescriptor,
  type ImageLibraryEntry,
  type ImageLibraryLayer,
  type ImageLibraryPage,
  type ImageLibraryRepresentation,
  type ImagePage,
  type ImageReferenceImpact,
  type ImageSource,
  type ImageTagUpdate,
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
  impactSummary,
  isTerminalBuild,
  libraryManifestDigest,
  libraryRepository,
  libraryTagsLabel,
  libraryTitle,
  representationLabel,
  shortDigest,
  sourceLabel,
} from './model';
export { useImageBuilds, type ImageBuildsState } from './hooks/useImageBuilds';
export {
  useImageLibraryPage,
  type ImageLibraryPageState,
} from './hooks/useImageLibraryPage';
export { useImagesPage } from './hooks/useImagesPage';
