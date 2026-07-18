.PHONY: all clean run vectors cuda-h0 h0-reference block2-reference block2-host bench cuda-check cuda-profile cuda-profile-launch cuda-profile-timeline cuda-profile-timeline-stats library library-smoke local-miner cuda-helper

NVCC ?= /usr/local/cuda-12.8/bin/nvcc
CUDA_ARCH ?= sm_120
CXXFLAGS ?= -O2 -std=c++17 -diag-suppress=177
CUDA_OPT_FLAGS ?= -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_PERMUTE -DBRC_CUDA_OPT_HYBRID -DBRC_CUDA_OPT_H0

all: device-probe

device-probe: device_probe.cu
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) $< -o $@

diagnose: brc-pow-cuda
	./brc-pow-cuda diagnose

run: device-probe
	./device-probe

vectors: reference-vectors
	./reference-vectors

h0-reference: h0_reference.cpp
	$(CXX) -O2 -std=c++17 $< -lcrypto -o h0-reference

block2-reference:
	cargo run --manifest-path reference/Cargo.toml --release -- "$${HEADER_HEX:?set HEADER_HEX to 296 hex characters}"

block2-host: block2_reference.cpp
	$(CXX) -O2 -std=c++17 $< -lcrypto -o block2-host

cuda-h0: brc-pow-cuda
	./brc-pow-cuda h0 "$${HEADER_HEX:?set HEADER_HEX to 296 hex characters}"

brc-pow-cuda: argon2_cuda.cu argon2_block.cuh argon2_memory.cuh
	$(NVCC) $(CXXFLAGS) $(CUDA_OPT_FLAGS) -arch=$(CUDA_ARCH) $< -o $@

brc_argon_cuda.o: argon2_cuda.cu argon2_block.cuh argon2_memory.cuh include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) $(CUDA_OPT_FLAGS) -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c argon2_cuda.cu -o $@

library: libbrc-argon-cuda.a

library-smoke: libbrc-argon-cuda.a library_smoke.cpp include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) library_smoke.cpp libbrc-argon-cuda.a -o library-smoke

cuda-validation: libbrc-argon-cuda.a cuda_validation.cpp include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) cuda_validation.cpp libbrc-argon-cuda.a -o cuda-validation

cuda-check: cuda-validation
	CUDA_CHECK_ROUNDS=$${CUDA_CHECK_ROUNDS:-10} CUDA_CHECK_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./cuda-validation

cuda-profile: cuda-validation
	@command -v ncu >/dev/null || (echo 'ncu (Nsight Compute) is required' >&2; exit 2)
	CUDA_CHECK_ROUNDS=1 CUDA_CHECK_SECONDS=$${CUDA_PROFILE_SECONDS:-1} ncu --set basic --target-processes all --launch-skip 6 --launch-count 1 --export "$${CUDA_PROFILE_OUT:-/tmp/fulgur-cuda-profile}" ./cuda-validation

cuda-profile-launch: cuda-validation
	@command -v ncu >/dev/null || (echo 'ncu (Nsight Compute) is required' >&2; exit 2)
	CUDA_CHECK_ROUNDS=1 CUDA_CHECK_SECONDS=$${CUDA_PROFILE_SECONDS:-1} ncu --section LaunchStats --target-processes all --launch-skip 6 --launch-count 1 --export "$${CUDA_PROFILE_OUT:-/tmp/fulgur-cuda-launch-profile}" ./cuda-validation

cuda-profile-timeline: cuda-validation
	@command -v nsys >/dev/null || (echo 'nsys (Nsight Systems) is required' >&2; exit 2)
	nsys profile --trace=cuda --cuda-memory-usage=true --sample=none --cpuctxsw=none --force-overwrite=true --output "$${CUDA_PROFILE_OUT:-/tmp/fulgur-cuda-timeline}" env CUDA_CHECK_ROUNDS=1 CUDA_CHECK_SECONDS=$${CUDA_PROFILE_SECONDS:-10} ./cuda-validation

cuda-profile-timeline-stats:
	@command -v nsys >/dev/null || (echo 'nsys (Nsight Systems) is required' >&2; exit 2)
	nsys stats --force-export=true --report cuda_api_sum,cuda_gpu_kern_sum,cuda_gpu_mem_time_sum --format table "$${CUDA_PROFILE_REPORT:-/tmp/fulgur-cuda-timeline.nsys-rep}"

local-miner: libbrc-argon-cuda.a local_miner.cpp include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) local_miner.cpp libbrc-argon-cuda.a -o brc-argon-local

cuda-helper: libbrc-argon-cuda.a cuda_helper.cpp include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) cuda_helper.cpp libbrc-argon-cuda.a -o brc-argon-cuda-helper

libbrc-argon-cuda.a: brc_argon_cuda.o
	ar rcs $@ $<

bench: brc-pow-cuda
	@test -n "$${HEADER_HEX}" || (echo 'set HEADER_HEX to a 148-byte header hex string' >&2; exit 2)
	@test "$${NONCE_COUNT:-1}" -ge 1 -a "$${NONCE_COUNT:-1}" -le 192 || (echo 'NONCE_COUNT must be between 1 and 192' >&2; exit 2)
	@test "$${ROUNDS:-1}" -ge 1 -a "$${ROUNDS:-1}" -le 1000 || (echo 'ROUNDS must be between 1 and 1000' >&2; exit 2)
	timeout 60s ./brc-pow-cuda bench "$${HEADER_HEX}" "$${NONCE_START:-0}" "$${NONCE_COUNT:-1}" "$${ROUNDS:-1}"

reference-vectors: reference_vectors.cpp
	$(CXX) -O2 -std=c++17 $< -ldl -o $@

clean:
	rm -f device-probe reference-vectors h0-reference block2-host brc-pow-cuda brc_argon_cuda.o libbrc-argon-cuda.a library-smoke cuda-validation brc-argon-local brc-argon-cuda-helper
