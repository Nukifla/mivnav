// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! A single, minimal disjoint-set (union-find) implementation, shared by
//! every module in this crate that needs one — `derive::aid_group`
//! (grouping multi-part aid-to-navigation features) and
//! `mivnav::topology` (per-band navigable connected components) each
//! used to carry an independent copy of the identical algorithm; a
//! second, independently-tuned implementation is exactly the kind of
//! quiet divergence this crate's own conventions warn against (see
//! `routing::artifact::search`'s module docs on the shared `Supercover`
//! walk for the same argument, applied there to a DDA rather than a
//! disjoint set).
//!
//! Path halving plus deterministic min-root union: the SMALLER index
//! always becomes a group's root, so which root a group ends up under is
//! reproducible from the union CALLS alone, not from a hash or an
//! incidental `rank` counter's own history. Callers that already
//! renumber canonically downstream (`mivnav::topology`) do not depend on
//! this determinism, but it costs nothing to keep and removes one more
//! thing a future caller has to think about.

pub(crate) struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    pub(crate) fn new(n: usize) -> UnionFind {
        UnionFind {
            parent: (0..n).collect(),
        }
    }

    /// Return every element to its own singleton set, keeping the backing
    /// allocation. A caller that runs many disjoint-set passes over the
    /// same element count (`mivnav::topology`'s ten depth bands) resets
    /// one buffer instead of allocating — and faulting in — a fresh
    /// `Vec` each time. Element count is unchanged.
    pub(crate) fn reset(&mut self) {
        for (i, p) in self.parent.iter_mut().enumerate() {
            *p = i;
        }
    }

    /// The raw `parent` column, for a caller that unions a set of
    /// DISJOINT index ranges in parallel and then hands the merged result
    /// straight back to [`find`](Self::find) / [`union`](Self::union).
    ///
    /// A fresh [`new`](Self::new) leaves every entry self-referential
    /// (`parent[i] == i`); a worker that only ever links indices inside
    /// its own range keeps the "a group's root is its smallest member"
    /// invariant this type's `union` maintains, so the ranges recombine
    /// with no fix-up. Linking across the `&mut [usize]` slices handed
    /// out here would break that invariant — the caller is responsible
    /// for the disjointness.
    pub(crate) fn parent_mut(&mut self) -> &mut [usize] {
        &mut self.parent
    }

    pub(crate) fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]]; // path halving
            x = self.parent[x];
        }
        x
    }

    pub(crate) fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // Deterministic: the larger root always attaches under the
            // smaller, so the final root of any group is its own
            // smallest member, independent of union order.
            self.parent[ra.max(rb)] = ra.min(rb);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_joins_and_find_agrees() {
        let mut uf = UnionFind::new(5);
        uf.union(0, 1);
        uf.union(1, 2);
        assert_eq!(uf.find(0), uf.find(2));
        assert_ne!(uf.find(0), uf.find(3));
    }

    #[test]
    fn min_root_wins_regardless_of_union_order() {
        let mut uf = UnionFind::new(4);
        uf.union(3, 1);
        uf.union(1, 2);
        assert_eq!(uf.find(3), 1);
        assert_eq!(uf.find(2), 1);

        let mut reordered = UnionFind::new(4);
        reordered.union(1, 2);
        reordered.union(3, 1);
        assert_eq!(reordered.find(3), 1);
        assert_eq!(reordered.find(2), 1);
    }

    #[test]
    fn singletons_are_their_own_root() {
        let mut uf = UnionFind::new(3);
        assert_eq!(uf.find(0), 0);
        assert_eq!(uf.find(1), 1);
        assert_eq!(uf.find(2), 2);
    }

    #[test]
    fn a_repeated_union_is_a_no_op() {
        let mut uf = UnionFind::new(2);
        uf.union(0, 1);
        uf.union(0, 1);
        uf.union(1, 0);
        assert_eq!(uf.find(0), uf.find(1));
    }
}
