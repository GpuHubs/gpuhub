# Workspace images with libraries

A GPUhub workspace has no internet, so a builder can't `pip install` inside it. These two images carry the libraries builders ask for most.

| Image | Based on | Adds |
| --- | --- | --- |
| `ml-base` | `python:3.12-slim` | numpy, pandas, scipy, scikit-learn, matplotlib |
| `ml-gpu` | the PyTorch CUDA image | pandas, scipy, scikit-learn, matplotlib, transformers, accelerate, safetensors, sentencepiece |

## Build

```
docker build -t ghcr.io/gpuhubs/ml-base:1 images/ml-base
docker build -t ghcr.io/gpuhubs/ml-gpu:1  images/ml-gpu
```

## What is still needed before renters can use them

1. **Publish the images.** The `images` workflow (`.github/workflows/images.yml`) builds both and pushes them to GHCR. Run it from the Actions tab, then set each package to Public (GitHub: Packages, the package, Package settings, Change visibility) so machines can pull without a login.
2. ~~Add the image names to the allowed list~~ Done: `ghcr.io/gpuhubs/ml-base:1` and `ghcr.io/gpuhubs/ml-gpu:1` are in `ALLOWED_IMAGES` in `coordinator/src/hub.ts` and `provider/src/docker.ts`. A machine only advertises images it has pulled, so nothing changes for machines that don't have them.
3. **Release a new Windows installer.** `prepare` pulls the library images when `GPUHUB_PULL_ML=1` is set; the app still needs a switch for owners to turn that on. The first start already downloads about 12 GB, so the extra size is worth showing to owners before they accept it.

Until then, builders can use the three images that exist today and upload pure-Python libraries with their code.

## Big models

No folder of an owner's PC is ever mounted into a workspace, and a workspace has no internet. So a big model goes in an image (`images/model-template`): a machine downloads it once, and every renter after that uses it without uploading the weights again.
