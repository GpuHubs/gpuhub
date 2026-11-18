# A model baked into an image: the weights are downloaded to a machine once, and every renter after that uses them from the image.
# A workspace has no internet and no folder of the owner's PC is ever mounted, so this is how a big model gets onto a machine.
#
#   1. put the weights next to this file in ./weights  (for example a Hugging Face snapshot)
#   2. docker build -t ghcr.io/gpuhubs/model-<name>:1 images/model-template
#   3. publish it to a registry, add the name to ALLOWED_IMAGES (coordinator/src/hub.ts and provider/src/docker.ts)
#
# In a workspace the weights are at /models/<name>. Check the model's licence before you publish it.
FROM ghcr.io/gpuhubs/ml-gpu:1
COPY --chown=1000:1000 weights /models/model
