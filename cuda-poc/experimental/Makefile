.PHONY: all run all-experiments batch-sweep focused-sweep focus persistent-bench persistent persistent-best compare-variants optimization-suite validation-ref validation-ref-address validation-ref-address-s0 validation-ref-address-s1 validation-ref-permute validation-ref-hybrid validation-ref-h0 clean

NVCC ?= /usr/local/cuda-12.8/bin/nvcc
CUDA_ARCH ?= sm_120
CXXFLAGS ?= -O2 -std=c++17 -diag-suppress=177

all: warp-g-bench batch-sweep focused-sweep persistent-bench

OPT_NVCC_FLAGS ?= -DBRC_CUDA_OPT_REF_INDEX

warp-g-bench: warp_g_bench.cu
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) $< -o $@

run: warp-g-bench
	./warp-g-bench

batch-sweep: batch_sweep.cpp ../libbrc-argon-cuda.a
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) batch_sweep.cpp ../libbrc-argon-cuda.a -o batch-sweep

focused-sweep: focused_sweep.cpp ../libbrc-argon-cuda.a
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) focused_sweep.cpp ../libbrc-argon-cuda.a -o focused-sweep

focus: focused-sweep
	./focused-sweep

persistent-bench: persistent_bench.cu
	$(NVCC) $(CXXFLAGS) -DBRC_ARGON_CUDA_LIBRARY -arch=$(CUDA_ARCH) $< -o $@

persistent: persistent-bench
	./persistent-bench

persistent-best: persistent_bench.cu
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_PERMUTE -DBRC_CUDA_OPT_HYBRID -DBRC_CUDA_OPT_H0 -DBRC_ARGON_CUDA_LIBRARY -arch=$(CUDA_ARCH) $< -o $@

libstable-cuda.so: ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -shared -arch=$(CUDA_ARCH) ../argon2_cuda.cu -o $@

liboptimized-cuda.so: ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_PERMUTE -DBRC_CUDA_OPT_HYBRID -DBRC_CUDA_OPT_H0 -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -shared -arch=$(CUDA_ARCH) ../argon2_cuda.cu -o $@

variant-compare: variant_compare.cpp libstable-cuda.so liboptimized-cuda.so
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) variant_compare.cpp -ldl -o $@

compare-variants: variant-compare
	CUDA_COMPARE_SECONDS=$${CUDA_COMPARE_SECONDS:-30} ./variant-compare ./libstable-cuda.so ./liboptimized-cuda.so

optimization-suite: ../cuda-validation validation-ref validation-ref-permute validation-ref-hybrid validation-ref-h0 persistent-best compare-variants
	CUDA_CHECK_ROUNDS=$${CUDA_CHECK_ROUNDS:-10} CUDA_CHECK_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./../cuda-validation
	CUDA_CHECK_ROUNDS=$${CUDA_CHECK_ROUNDS:-10} CUDA_CHECK_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./validation-ref
	CUDA_CHECK_ROUNDS=$${CUDA_CHECK_ROUNDS:-10} CUDA_CHECK_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./validation-ref-permute
	CUDA_CHECK_ROUNDS=$${CUDA_CHECK_ROUNDS:-10} CUDA_CHECK_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./validation-ref-hybrid
	CUDA_CHECK_ROUNDS=$${CUDA_CHECK_ROUNDS:-10} CUDA_CHECK_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./validation-ref-h0
	CUDA_COMPARE_TRIALS=$${CUDA_COMPARE_TRIALS:-1} CUDA_COMPARE_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./persistent-best
	CUDA_COMPARE_SECONDS=$${CUDA_CHECK_SECONDS:-30} ./variant-compare ./libstable-cuda.so ./liboptimized-cuda.so

../cuda-validation: ../cuda_validation.cpp ../libbrc-argon-cuda.a
	$(MAKE) -C .. cuda-validation

validation-ref: ../cuda_validation.cpp ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) $(OPT_NVCC_FLAGS) -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-argon2.o -o $@

validation-ref-address: ../cuda_validation.cpp ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_ADDRESS -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-address-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-address-argon2.o -o $@

validation-ref-address-s0: ../cuda_validation.cpp ../argon2_cuda.cu
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_ADDRESS -DBRC_CUDA_OPT_ADDRESS_SLICE0 -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-address-s0-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-address-s0-argon2.o -o $@

validation-ref-address-s1: ../cuda_validation.cpp ../argon2_cuda.cu
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_ADDRESS -DBRC_CUDA_OPT_ADDRESS_SLICE1 -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-address-s1-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-address-s1-argon2.o -o $@

validation-ref-permute: ../cuda_validation.cpp ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_PERMUTE -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-permute-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-permute-argon2.o -o $@

validation-ref-hybrid: ../cuda_validation.cpp ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_PERMUTE -DBRC_CUDA_OPT_HYBRID -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-hybrid-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-hybrid-argon2.o -o $@

validation-ref-h0: ../cuda_validation.cpp ../argon2_cuda.cu ../argon2_memory.cuh ../argon2_block.cuh ../include/brc_argon_cuda.h
	$(NVCC) $(CXXFLAGS) -DBRC_CUDA_OPT_REF_INDEX -DBRC_CUDA_OPT_PERMUTE -DBRC_CUDA_OPT_HYBRID -DBRC_CUDA_OPT_H0 -DBRC_ARGON_CUDA_LIBRARY -Xcompiler -fPIC -arch=$(CUDA_ARCH) -c ../argon2_cuda.cu -o validation-ref-h0-argon2.o
	$(NVCC) $(CXXFLAGS) -arch=$(CUDA_ARCH) ../cuda_validation.cpp validation-ref-h0-argon2.o -o $@

all-experiments: all
	./warp-g-bench
	./batch-sweep

clean:
	rm -f warp-g-bench batch-sweep focused-sweep persistent-bench persistent-best variant-compare libstable-cuda.so liboptimized-cuda.so validation-ref validation-ref-argon2.o validation-ref-address validation-ref-address-argon2.o validation-ref-address-s0 validation-ref-address-s0-argon2.o validation-ref-address-s1 validation-ref-address-s1-argon2.o validation-ref-permute validation-ref-permute-argon2.o validation-ref-hybrid validation-ref-hybrid-argon2.o validation-ref-h0 validation-ref-h0-argon2.o
