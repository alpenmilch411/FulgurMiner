cmake_minimum_required(VERSION 3.24)

project(brc_argon_cuda VERSION 0.1.0 LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_ARCHITECTURES "120" CACHE STRING "CUDA compute capabilities")

find_package(CUDAToolkit REQUIRED)

add_library(brc_argon_cuda STATIC argon2_cuda.cu)
target_compile_definitions(brc_argon_cuda PRIVATE BRC_ARGON_CUDA_LIBRARY)
target_include_directories(brc_argon_cuda
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
  PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(brc_argon_cuda PUBLIC CUDA::cudart)

add_executable(brc_argon_cuda_smoke library_smoke.cpp)
target_link_libraries(brc_argon_cuda_smoke PRIVATE brc_argon_cuda)

install(TARGETS brc_argon_cuda
        ARCHIVE DESTINATION lib
        INCLUDES DESTINATION include)
install(FILES include/brc_argon_cuda.h DESTINATION include)
