cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(scrypt_ll C)

add_bare_module(scrypt_ll)

target_sources(${scrypt_ll} PRIVATE binding.c romix.c)
