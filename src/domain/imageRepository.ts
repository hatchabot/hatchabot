/**
 * An image name's repository: without its digest, then without its tag (a
 * registry's port stays). A default pinned by digest
 * (`hatchabot-runtime@sha256:…`, which upgrade.sh leaves as it is) was read
 * as the repository `hatchabot-runtime@sha256`, and the fleet's images were
 * named `…@sha256:<tag>`, which is no image name (review of HB-1182).
 * scripts/build-runtime-image.sh reads its REPO the same way. It took the
 * place of imageRecipe's repoOf, the same but for the digest step, so an
 * import names a file's image in the repository the image list reads.
 */
export const imageRepository = (ref: string): string => ref.replace(/@[^/]*$/, '').replace(/:[^:/]*$/, '');
