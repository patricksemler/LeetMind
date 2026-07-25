# LeetMind C++ sandbox runner image — docs/CONTRACTS.md §6 / §6.1.
#
# Not exercised until M4 (the C++ judge pipeline), but must build cleanly now so
# scripts/build-images.sh always produces both images. Same runtime constraints as the Python
# image: no network at runtime (enforced by `docker run --network none`, not by this
# Dockerfile), non-root, read-only rootfs with a writable /work tmpfs supplied at `docker run`
# time.
#
# `gcc:14` ships a matching g++ toolchain capable of `g++ -std=c++20 -O2 -pipe
# -static-libstdc++` (see docs/CONTRACTS.md §7's C++ bundle compile step).
FROM gcc:14

LABEL leetmind.runner=cpp

WORKDIR /work

# Debian's base image (gcc:14 is Debian-based) maps uid/gid 65534 to nobody/nogroup, matching
# the sandbox's `-u 65534:65534` flag. Set explicitly here too as defense-in-depth.
USER 65534:65534

# No CMD/ENTRYPOINT: the sandbox always supplies argv explicitly (compile then run).
