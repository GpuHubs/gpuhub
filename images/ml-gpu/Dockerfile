# A GPUhub workspace image for GPU work: PyTorch with CUDA plus the usual data and model libraries.
# A workspace has no internet, so everything a job needs has to be inside the image. Model weights are not included: upload the ones you use.
FROM pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime

# The base image's Python is managed by the system (PEP 668); inside a throwaway image the flag is safe.
RUN pip install --no-cache-dir --break-system-packages \
      pandas==2.2.3 \
      scipy==1.14.1 \
      scikit-learn==1.5.2 \
      matplotlib==3.9.2 \
      transformers==4.46.3 \
      accelerate==1.1.1 \
      safetensors==0.4.5 \
      sentencepiece==0.2.0

WORKDIR /workspace
